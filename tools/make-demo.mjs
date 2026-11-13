// Makes a synthetic overhead putt video with ffmpeg, plus a .json file of the
// true answers, to test the tracker against.
//
//   node tools/make-demo.mjs [key=value ...]
//
//   out=demo/putt-demo.mp4  angle=2 (deg, + = starts right)  stimp=10  mph=4.47
//   fps=30  scale=0.3 (cm per pixel; 0.13 ~ phone 4 ft up)
//   Putter (right-handed golfer, so "inside" = left of the line, "open" = face aimed right):
//   back=20 thru=25 (cm)  arc=1.5 (cm inside at the top)  path=0 (deg, + = in-to-out)
//   face=0.5 (deg open at impact)  rot=3 (deg the face opens by the top)
//   tback=0.6 tfwd=0.3 (s)  stickers=2 (0, 1 or 2)
//
// The ball skids for 0.1 s, then rolls with the steady slowdown that a green of
// that Stimp reading gives.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const num = (k, d) => (arg[k] != null ? parseFloat(arg[k]) : d);
const OUT = arg.out ?? 'demo/putt-demo.mp4';
const ANGLE = num('angle', 2), STIMP = num('stimp', 10), LAUNCH_MPS = num('mph', 4.47) / 2.23694;
const FPS = num('fps', 30), CM_PER_PX = num('scale', 0.3);
const BACK = num('back', 20), THRU = num('thru', 25), ARC = num('arc', 1.5), PATH = num('path', 0);
const FACE = num('face', 0.5), ROT = num('rot', 3), TBACK = num('tback', 0.6), TFWD = num('tfwd', 0.3);
const STICKERS = num('stickers', 2);
const W = 720, H = 1280, SECONDS = 5;
const px = (cm) => cm / CM_PER_PX;

const BALL_R = px(4.267 / 2);
const HOLE_R = px(5.4);
const ball0 = { x: 360, y: Math.min(1100, H - px(BACK + 12) - 20) };
const hole = { x: 360, y: ball0.y - px(270) };

function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const rand = rng(7);

// Static grass texture (mowing stripes scale with the zoom).
const grass = new Uint8Array(W * H * 3);
for (let i = 0; i < W * H; i++) {
  const n = rand() * 30 - 15, x = i % W, y = (i / W) | 0;
  const stripe = Math.floor((y * CM_PER_PX) / 48) % 2 ? 8 : -6;
  const shade = 10 * Math.sin((x + y) / 300);
  grass[i * 3] = 55 + n * 0.6 + stripe + shade;
  grass[i * 3 + 1] = 125 + n + stripe * 1.6 + shade;
  grass[i * 3 + 2] = 48 + n * 0.5 + stripe + shade;
}

// ---- ball
const a = (ANGLE * Math.PI) / 180;
const dir = { x: Math.sin(a), y: -Math.cos(a) };   // aim is straight up the screen
const impactT = 1.5;
const ROLL_DECEL = 1.83 ** 2 / (2 * STIMP * 0.3048);
const SKID_DECEL = 3.0, SKID_T = 0.1;
const v1 = LAUNCH_MPS - SKID_DECEL * SKID_T;
function metresAt(t) {
  const u = t - impactT;
  if (u <= 0) return 0;
  if (u < SKID_T) return LAUNCH_MPS * u - 0.5 * SKID_DECEL * u * u;
  const sk = LAUNCH_MPS * SKID_T - 0.5 * SKID_DECEL * SKID_T ** 2;
  const w = Math.min(u - SKID_T, v1 / ROLL_DECEL);
  return sk + v1 * w - 0.5 * ROLL_DECEL * w * w;
}
const ballAt = (t) => { const d = px(metresAt(t) * 100); return { x: ball0.x + dir.x * d, y: ball0.y + dir.y * d }; };

// ---- putter (head centre in cm: along = toward target, across = inside)
const k = ARC / BACK ** 2 - Math.tan((PATH * Math.PI) / 180) / BACK;  // so inside at the top = ARC exactly
const tp = Math.tan((PATH * Math.PI) / 180);
const acrossOf = (al) => k * al * al - tp * al;
const vImp = (BACK * Math.PI) / (2 * TFWD);                   // cm/s at impact
const TTHRU = (THRU * Math.PI) / (2 * vImp);
const tStart = impactT - TFWD - TBACK;
function alongAt(t) {
  if (t <= tStart) return 0;
  if (t < impactT - TFWD) { const s = (t - tStart) / TBACK; return -BACK * (1 - Math.cos(Math.PI * s)) / 2; }
  if (t < impactT) { const s = (t - (impactT - TFWD)) / TFWD; return -BACK * Math.cos((Math.PI / 2) * s); }
  const s = Math.min(1, (t - impactT) / TTHRU); return THRU * Math.sin((Math.PI / 2) * s);
}
const faceOpenAt = (al) => FACE + (al < 0 ? ROT * (-al / BACK) : -ROT * (al / BACK));
const HEAD_GAP = 4.267 / 2 + 0.3 + 1.5;                       // ball centre to head centre at address (cm)
function putterAt(t) {
  const al = alongAt(t), ac = acrossOf(al);
  const c = { x: ball0.x - px(ac), y: ball0.y + px(HEAD_GAP) - px(al) };   // inside = -x for a right-hander
  const th = (faceOpenAt(al) * Math.PI) / 180;
  return { c, th };
}
// Toe/heel stickers 4.5 cm either side of the centre, along the face line.
function stickersAt(t) {
  const { c, th } = putterAt(t);
  const fx = Math.cos(th), fy = Math.sin(th);
  return [{ x: c.x + fx * px(4.5), y: c.y + fy * px(4.5) }, { x: c.x - fx * px(4.5), y: c.y - fy * px(4.5) }];
}

function frame(t) {
  const f = Buffer.from(grass);
  const put = (x, y, r, g, b, alpha = 1) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 3;
    f[i] = f[i] * (1 - alpha) + r * alpha; f[i + 1] = f[i + 1] * (1 - alpha) + g * alpha; f[i + 2] = f[i + 2] * (1 - alpha) + b * alpha;
  };
  const disc = (cx, cy, R, col) => {
    for (let y = Math.floor(cy - R - 2); y <= cy + R + 2; y++) for (let x = Math.floor(cx - R - 2); x <= cx + R + 2; x++) {
      const cov = Math.max(0, Math.min(1, R - Math.hypot(x + 0.5 - cx, y + 0.5 - cy) + 0.5));
      if (cov > 0) put(x, y, ...col(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / R), cov);
    }
  };
  if (hole.y + HOLE_R > 0) disc(hole.x, hole.y, HOLE_R, () => [18, 22, 16]);
  // putter head: dark rotated rectangle, 11 x 3 cm
  const { c, th } = putterAt(t);
  const fx = Math.cos(th), fy = Math.sin(th), hw = px(5.5), hd = px(1.5);
  for (let y = Math.floor(c.y - hw - 3); y <= c.y + hw + 3; y++) for (let x = Math.floor(c.x - hw - 3); x <= c.x + hw + 3; x++) {
    const dx = x + 0.5 - c.x, dy = y + 0.5 - c.y;
    const along = dx * fx + dy * fy, depth = -dx * fy + dy * fx;
    const cov = Math.max(0, Math.min(1, hw - Math.abs(along) + 0.5)) * Math.max(0, Math.min(1, hd - Math.abs(depth) + 0.5));
    if (cov > 0) put(x, y, 62, 64, 70, cov);
  }
  stickersAt(t).slice(0, STICKERS).forEach((s) => disc(s.x, s.y, px(0.95), () => [255, 45, 160]));
  const b = ballAt(t);
  disc(b.x, b.y, BALL_R, (d) => { const sh = 245 - 45 * d * d; return [sh, sh, sh - 4]; });
  for (let i = 0; i < f.length; i += 3 * 7) f[i + 1] = Math.max(0, Math.min(255, f[i + 1] + (rand() * 10 - 5)));
  return f;
}

mkdirSync(dirname(OUT), { recursive: true });
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', `${FPS}`, '-i', '-',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-movflags', '+faststart', OUT], { stdio: ['pipe', 'inherit', 'inherit'] });
for (let i = 0; i < FPS * SECONDS; i++) {
  if (!ff.stdin.write(frame(i / FPS))) await new Promise((r) => ff.stdin.once('drain', r));
}
ff.stdin.end();
await new Promise((r) => ff.on('close', r));

const truth = {
  W, H, fps: FPS, scale: CM_PER_PX, ball: ball0, hole, holeInFrame: hole.y > HOLE_R,
  stickers: stickersAt(0).slice(0, STICKERS),
  angle: ANGLE, stimp: STIMP, mph: LAUNCH_MPS * 2.23694,
  stroke: STICKERS ? {
    backCm: BACK, throughCm: THRU, insideTopCm: ARC, insideThroughCm: acrossOf(THRU), pathDeg: PATH,
    faceImpact: FACE, faceTop: FACE + ROT, tempo: TBACK / TFWD,
  } : null,
};
writeFileSync(OUT.replace(/\.mp4$/, '.json'), JSON.stringify(truth, null, 1));
console.log(`${OUT}: ${JSON.stringify({ angle: ANGLE, stimp: STIMP, mph: +truth.mph.toFixed(2), fps: FPS, scale: CM_PER_PX, ...truth.stroke })}`);
