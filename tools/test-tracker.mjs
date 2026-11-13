// Runs the real tracker + math on synthetic putts with known answers.
//   node tools/test-tracker.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectBallAt, detectHoleAt, detectStickerAt, autoFindStickers } from '../js/tracker.js';
import { followBall } from '../js/follow.js';
import { followPutter, analyzeStroke } from '../js/stroke.js';
import { analyzePutt } from '../js/analysis.js';

const cases = [
  'angle=2 stimp=10 mph=4.47 fps=30',                                        // default stroke: slight arc
  'angle=-1.5 stimp=8 mph=4.0 fps=60 arc=0 face=-0.8 rot=0',                 // straight back, closed
  'angle=0 stimp=12 mph=4.2 fps=60 arc=3 path=1.5 face=1 tback=0.7 tfwd=0.35', // strong arc, in-to-out
  'angle=0.5 stimp=9 mph=4.8 fps=30 stickers=1',                             // one sticker
  'angle=-4 stimp=11 mph=3.6 fps=30 arc=-1.2 face=-2 rot=1',                 // outside on the way back
  'angle=6 stimp=7 mph=4.2 fps=60 stickers=0',                               // no stickers
  'angle=-1 scale=0.13 fps=60 arc=0.4 face=-1 rot=2',                        // close-up: hole off screen
  'auto=1 angle=1 scale=0.13 fps=30 bally=0.72 impact=4.5 seconds=9 arc=0.8 face=0.7', // live mode: no taps at all
];

const dir = mkdtempSync(join(tmpdir(), 'golflab-'));
let failed = 0;
const near = (got, want, tol) => got != null && Math.abs(got - want) <= tol;

for (const [n, spec] of cases.entries()) {
  const file = join(dir, `putt_${n}.mp4`);
  execFileSync('node', ['tools/make-demo.mjs', `out=${file}`, ...spec.split(' ')]);
  const T = JSON.parse(readFileSync(file.replace('.mp4', '.json'), 'utf8'));
  const { W, H, fps } = T;
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 2 ** 31 });
  const frameBytes = W * H * 4, nFrames = raw.length / frameBytes;
  let cur = 0;
  const frameAt = async (t) => { cur = Math.min(nFrames - 1, Math.round(t * fps)); return cur / fps; };
  const patch = (cx, cy, R) => {
    const x0 = Math.max(0, Math.floor(cx - R)), y0 = Math.max(0, Math.floor(cy - R));
    const x1 = Math.min(W, Math.ceil(cx + R)), y1 = Math.min(H, Math.ceil(cy + R));
    if (x1 - x0 < 3 || y1 - y0 < 3) return null;
    const w = x1 - x0, h = y1 - y0, data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const off = cur * frameBytes + ((y0 + y) * W + x0) * 4;
      data.set(raw.subarray(off, off + w * 4), y * w * 4);
    }
    return { width: w, height: h, data, ox: x0, oy: y0 };
  };

  // The user's taps (slightly off, like a real finger).
  await frameAt(0.01);
  const ball = detectBallAt(patch(T.ball.x + 3, T.ball.y - 4, 60), T.ball.x + 3, T.ball.y - 4);
  const auto = spec.includes('auto=1');
  let target, holeDistCm = null;
  if (auto) target = { x: ball.x, y: ball.y - 500, virtual: true };   // "putt toward the top of the picture"
  else if (T.holeInFrame) target = detectHoleAt(patch(T.hole.x + 8, T.hole.y + 10, 90), T.hole.x + 8, T.hole.y + 10, ball.area);
  else { target = { x: T.ball.x, y: T.ball.y - 500 }; holeDistCm = 270; }
  let stickers = auto ? [] : T.stickers.map((s) => detectStickerAt(patch(s.x + 2, s.y + 2, 40), s.x + 2, s.y + 2));

  const lines = [];
  const check = (label, ok, txt) => { lines.push(`${ok ? '  ' : '✗ '}${label} ${txt}`); return ok; };
  let ok = check('taps', !!(ball && target && stickers.every(Boolean)), `ball r=${ball?.r.toFixed(2)} target=${!!target} stickers=${stickers.filter(Boolean).length}/${T.stickers.length}`);

  const track = await followBall({ ball, tStart: 0.01, duration: nFrames / fps, frameAt, patch, frameSize: { W, H } });
  if (track.error) { console.log(`FAIL #${n} ${spec}: ${track.error}`); failed++; continue; }
  const res = analyzePutt({ p0: ball, r: ball.r, target, points: track.points, endReason: track.endReason, holeDistCm });
  const sp = res.speed || {};
  const mph = sp.launchMps * 2.23694;
  ok &= check('angle', near(res.angleDeg, T.angle, 0.3), `${T.angle} → ${res.angleDeg.toFixed(2)}°`);
  ok &= check('speed', near(mph / T.mph, 1, 0.06), `${T.mph.toFixed(2)} → ${mph.toFixed(2)} mph`);
  ok &= check('stimp', near(sp.stimpFt, T.stimp, 0.5), `${T.stimp} → ${sp.stimpFt?.toFixed(2)}`);

  let tFrom = Math.max(0.01, sp.impactT - 2.5);
  if (auto) {                                  // same search the app does after a live recording
    tFrom = sp.impactT - 1.4;
    await frameAt(tFrom);
    const back = 6 / res.cmPerPx;
    stickers = autoFindStickers(patch(ball.x - res.aim.x * back, ball.y - res.aim.y * back, 18 / res.cmPerPx), res.cmPerPx);
    ok &= check('auto-stickers', stickers.length === 2, `found ${stickers.length}/2`);
  }
  if (stickers.length) {
    const frames = await followPutter({
      stickers, tFrom, tTo: Math.min(nFrames / fps - 0.01, sp.impactT + 0.8), frameAt, patch,
    });
    const sk = analyzeStroke({ frames, u: res.aim, cmPerPx: res.cmPerPx, impactT: sp.impactT, hand: 'right' });
    const S = T.stroke;
    if (sk.error) ok &= check('stroke', false, sk.error);
    else {
      ok &= check('back', near(sk.backCm, S.backCm, 1.2), `${S.backCm} → ${sk.backCm.toFixed(1)} cm`);
      ok &= check('through', near(sk.throughCm, S.throughCm, 1.5), `${S.throughCm} → ${sk.throughCm.toFixed(1)} cm`);
      ok &= check('in@top', near(sk.insideTopCm, S.insideTopCm, 0.4), `${S.insideTopCm} → ${sk.insideTopCm.toFixed(2)} cm (${sk.shape})`);
      ok &= check('in@thru', near(sk.insideThroughCm, S.insideThroughCm, 0.5), `${S.insideThroughCm.toFixed(2)} → ${sk.insideThroughCm.toFixed(2)} cm`);
      ok &= check('path', near(sk.pathDeg, S.pathDeg, 0.8), `${S.pathDeg} → ${sk.pathDeg?.toFixed(2)}°`);
      ok &= check('tempo', near(sk.tempo?.ratio, S.tempo, 0.15), `${S.tempo} → ${sk.tempo?.ratio.toFixed(2)} : 1`);
      if (stickers.length === 2) {
        ok &= check('face@imp', near(sk.face.impact, S.faceImpact, 0.6), `${S.faceImpact} → ${sk.face.impact?.toFixed(2)}°`);
        ok &= check('face@top', near(sk.face.top, S.faceTop, 0.8), `${S.faceTop} → ${sk.face.top?.toFixed(2)}°`);
      }
    }
  }
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} #${n} ${spec}\n${lines.join('\n')}`);
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
