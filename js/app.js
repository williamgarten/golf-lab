import { detectBallAt, detectHoleAt, detectStickerAt, findStickers } from './tracker.js';
import { followBall } from './follow.js';
import { followPutter, analyzeStroke } from './stroke.js';
import { analyzePutt, summarize, greenSpeed, fmtAngle, fmtLen, fmtSpeed, paceVerdict, HOLE_RADIUS_CM } from './analysis.js';
import { putts, settings, lastSetup } from './store.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const view = $('view');
const vctx = view.getContext('2d');
const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });

const MAX_DIM = 1280;      // analysis resolution (longest side)

const S = {
  stage: 'pick',           // pick | ball | target | putter | analyzing | result
  W: 0, H: 0,
  ball: null,              // { x, y, r, area, contrast }
  target: null,            // { x, y, snapped }
  stickers: [],            // putter stickers at address: [{ x, y, area, r, hue }]
  holeDistCm: null,        // typed in when the hole isn't in the picture
  stroke: null,            // analyzeStroke result
  tStart: 0,
  track: null,             // { restT, points: [{t,x,y}], endReason }
  result: null,
  savedId: null,
  replaying: false,
};

// ---------------------------------------------------------------- video I/O

function once(el, ev, ms = 4000) {
  return new Promise((res) => {
    const done = () => { el.removeEventListener(ev, done); clearTimeout(timer); res(); };
    const timer = setTimeout(done, ms);
    el.addEventListener(ev, done);
  });
}

async function seekTo(t) {
  t = Math.max(0, Math.min(t, video.duration - 0.001));
  if (Math.abs(video.currentTime - t) < 1e-4) return;
  const p = once(video, 'seeked');
  video.currentTime = t;
  await p;
}

async function loadVideo(src) {
  showStage('mark');
  setInstruction('Loading video…');
  resetMarks();
  S.savedId = null;
  video.src = src;
  await once(video, 'loadedmetadata', 10000);
  if (!video.videoWidth) { setInstruction('Couldn’t open that video. Try another clip.', true); return; }
  if (!Number.isFinite(video.duration)) {            // some recordings report Infinity
    video.currentTime = 1e7;
    await once(video, 'seeked');
  }
  try { await video.play(); video.pause(); } catch { /* fine: muted inline video */ }
  const k = Math.min(1, MAX_DIM / Math.max(video.videoWidth, video.videoHeight));
  S.W = work.width = view.width = Math.round(video.videoWidth * k);
  S.H = work.height = view.height = Math.round(video.videoHeight * k);
  const scrub = $('scrub');
  scrub.max = video.duration.toFixed(2);
  scrub.value = 0;
  await seekTo(0.01);
  setStage('ball');
}

function resetMarks() {
  S.ball = S.target = S.track = S.result = S.stroke = null;
  S.stickers = [];
  S.holeDistCm = null;
  $('hole-dist').value = '';
  $('result').hidden = true;
}

function grabFrame() {
  wctx.drawImage(video, 0, 0, S.W, S.H);
}

function patch(cx, cy, R) {
  if (!Number.isFinite(cx + cy + R)) return null;
  const x0 = Math.max(0, Math.floor(cx - R)), y0 = Math.max(0, Math.floor(cy - R));
  const x1 = Math.min(S.W, Math.ceil(cx + R)), y1 = Math.min(S.H, Math.ceil(cy + R));
  if (x1 - x0 < 3 || y1 - y0 < 3) return null;
  const im = wctx.getImageData(x0, y0, x1 - x0, y1 - y0);
  return { width: im.width, height: im.height, data: im.data, ox: x0, oy: y0 };
}

// ---------------------------------------------------------------- drawing

function draw({ upTo = Infinity, live = null } = {}) {
  const { W, H } = S;
  vctx.drawImage(live || video, 0, 0, W, H);
  const lw = Math.max(2, W / 360);
  vctx.lineCap = 'round';

  if (S.ball && S.target) {
    const { x: bx, y: by } = S.ball, { x: tx, y: ty } = S.target;
    const len = Math.hypot(tx - bx, ty - by);
    const ex = bx + ((tx - bx) / len) * (len + W * 0.08), ey = by + ((ty - by) / len) * (len + W * 0.08);
    vctx.setLineDash([lw * 4, lw * 3]);
    vctx.strokeStyle = 'rgba(255,255,255,0.9)';
    vctx.lineWidth = lw;
    line(bx, by, ex, ey);
    vctx.setLineDash([]);
  }
  if (S.target) {
    const r = S.ball ? HOLE_RADIUS_CM / (4.267 / (2 * S.ball.r)) : W * 0.02;
    ring(S.target.x, S.target.y, r, '#ffd84d', lw);
    vctx.fillStyle = '#ffd84d';
    dot(S.target.x, S.target.y, lw * 1.2);
  }
  if (S.track) {
    const pts = S.track.points.filter((p) => p.t <= upTo);
    if (pts.length) {
      vctx.strokeStyle = '#ff8a3d';
      vctx.lineWidth = lw * 1.4;
      vctx.beginPath();
      vctx.moveTo(S.ball.x, S.ball.y);
      for (const p of pts) vctx.lineTo(p.x, p.y);
      vctx.stroke();
    }
  }
  if (S.result && !S.result.error && upTo === Infinity) {
    const { startDir, onLine } = S.result;
    const len = Math.hypot(S.target.x - S.ball.x, S.target.y - S.ball.y);
    const ex = S.ball.x + startDir.x * len, ey = S.ball.y + startDir.y * len;
    vctx.strokeStyle = onLine ? '#4ee38a' : '#ff5a5a';
    vctx.lineWidth = lw * 1.2;
    line(S.ball.x, S.ball.y, ex, ey);
    vctx.fillStyle = vctx.strokeStyle;
    dot(ex, ey, lw * 2.2);
  }
  if (S.ball) ring(S.ball.x, S.ball.y, S.ball.r + lw * 2, '#ffd84d', lw);
  if (S.stroke && !S.stroke.error) drawStroke(upTo, lw);
  else for (const st of S.stickers) ring(st.x, st.y, st.r + lw * 2.5, '#4dd2ff', lw);
}

// Putter: dotted reference line through the address position (parallel to the aim),
// the head's path in cyan, and the face line at impact.
function drawStroke(upTo, lw) {
  const sk = S.stroke, u = S.result?.aim;
  if (!u || !sk.path.length) return;
  const L = S.W * 0.25;
  vctx.setLineDash([lw * 2, lw * 2]);
  vctx.strokeStyle = 'rgba(77,210,255,0.7)';
  vctx.lineWidth = lw * 0.8;
  line(sk.address.x - u.x * L, sk.address.y - u.y * L, sk.address.x + u.x * L, sk.address.y + u.y * L);
  vctx.setLineDash([]);
  const pts = sk.path.filter((p) => p.t <= upTo);
  if (pts.length > 1) {
    vctx.strokeStyle = '#4dd2ff';
    vctx.lineWidth = lw * 1.3;
    vctx.beginPath();
    vctx.moveTo(pts[0].x, pts[0].y);
    for (const p of pts) vctx.lineTo(p.x, p.y);
    vctx.stroke();
  }
  if (sk.impactLine && upTo === Infinity) {
    const [a, b] = sk.impactLine;
    vctx.strokeStyle = '#ff4fd8';
    vctx.lineWidth = lw * 1.2;
    line(a.x, a.y, b.x, b.y);
  }
}

function line(x0, y0, x1, y1) { vctx.beginPath(); vctx.moveTo(x0, y0); vctx.lineTo(x1, y1); vctx.stroke(); }
function ring(x, y, r, color, lw) { vctx.strokeStyle = color; vctx.lineWidth = lw; vctx.beginPath(); vctx.arc(x, y, r, 0, Math.PI * 2); vctx.stroke(); }
function dot(x, y, r) { vctx.beginPath(); vctx.arc(x, y, r, 0, Math.PI * 2); vctx.fill(); }

// ---------------------------------------------------------------- stages

function showStage(which) {
  $('step-pick').hidden = which !== 'pick';
  $('step-mark').hidden = which !== 'mark';
  $('guide').hidden = which !== 'pick';
}

function setInstruction(text, isError = false) {
  const el = $('instruction');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

function setStage(stage) {
  S.stage = stage;
  const busy = stage === 'analyzing';
  $('scrub-row').hidden = !(stage === 'ball');
  $('btn-analyze').hidden = stage === 'result';
  $('btn-analyze').disabled = stage !== 'putter';
  $('hole-row').hidden = !(stage === 'putter' && S.target && !S.target.snapped);
  $('hole-unit').textContent = settings.get().units === 'metric' ? 'm' : 'ft';
  $('btn-reset').disabled = busy || stage === 'ball';
  $('btn-same').hidden = !(stage === 'ball' && lastSetup.get());
  $('progress').hidden = !busy;
  if (stage === 'ball') setInstruction('1 · Slide to a moment before your stroke, then tap the ball.');
  if (stage === 'target') setInstruction('2 · Tap the hole, or the spot you’re aiming at on a breaking putt.');
  if (stage === 'putter') setInstruction(S.stickers.length
    ? `${S.stickers.length} sticker${S.stickers.length > 1 ? 's' : ''} marked. Tap Analyze.`
    : '3 \u00b7 Optional: tap the bright sticker(s) on your putter head. Then tap Analyze.');
  if (stage === 'analyzing') setInstruction('Following the ball\u2026');
  draw();
}

function frameTap(e) {
  // The canvas is letterboxed (object-fit: contain), so map through the drawn area.
  const rect = view.getBoundingClientRect();
  const k = Math.min(rect.width / S.W, rect.height / S.H);
  const ox = (rect.width - S.W * k) / 2, oy = (rect.height - S.H * k) / 2;
  return { x: (e.clientX - rect.left - ox) / k, y: (e.clientY - rect.top - oy) / k };
}

view.addEventListener('pointerup', (e) => {
  if (S.replaying) return;
  const p = frameTap(e);
  if (S.stage === 'ball') return pickBall(p);
  if (S.stage === 'target') return pickTarget(p);
  if (S.stage === 'putter') return pickSticker(p);
});

function pickBall(p) {
  grabFrame();
  const R = Math.max(40, S.W * 0.06);
  const pt = patch(p.x, p.y, R);
  const ball = pt && detectBallAt(pt, p.x, p.y);
  if (!ball) { setInstruction('Couldn’t find a white ball there — tap right on the ball.', true); return false; }
  S.ball = ball;
  S.tStart = video.currentTime;
  setStage('target');
  return true;
}

function pickTarget(p) {
  grabFrame();
  const R = Math.max(50, S.ball.r * 9);
  const pt = patch(p.x, p.y, R);
  const hole = pt && detectHoleAt(pt, p.x, p.y, S.ball.area);
  S.target = hole ? { ...hole, snapped: true } : { ...p, snapped: false };
  setStage('putter');
}

function pickSticker(p) {
  grabFrame();
  const pt = patch(p.x, p.y, Math.max(30, S.W * 0.04));
  const st = pt && detectStickerAt(pt, p.x, p.y);
  if (!st) { setInstruction('No bright sticker there. Neon pink or orange dots work best.', true); return; }
  if (S.stickers.length === 2) {                       // replace the nearest one
    const k = Math.hypot(S.stickers[0].x - st.x, S.stickers[0].y - st.y) < Math.hypot(S.stickers[1].x - st.x, S.stickers[1].y - st.y) ? 0 : 1;
    S.stickers[k] = st;
  } else if (!S.stickers.some((o) => Math.hypot(o.x - st.x, o.y - st.y) < st.r * 2)) S.stickers.push(st);
  setStage('putter');
}

$('hole-dist').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  S.holeDistCm = v > 0 ? v * (settings.get().units === 'metric' ? 100 : 30.48) : null;
});

$('scrub').addEventListener('input', async (e) => {
  await seekTo(parseFloat(e.target.value));
  $('time').textContent = `${video.currentTime.toFixed(1)}s`;
  draw();
});

$('btn-reset').addEventListener('click', async () => {
  resetMarks();
  await seekTo(S.tStart || 0.01);
  setStage('ball');
});

$('btn-same').addEventListener('click', async () => {
  const s = lastSetup.get();
  if (!s) return;
  if (!pickBall({ x: s.ball[0] * S.W, y: s.ball[1] * S.H })) {
    setInstruction('The ball isn’t where it was last time — tap it.', true);
    return;
  }
  S.target = { x: s.target[0] * S.W, y: s.target[1] * S.H, snapped: s.snapped };
  S.holeDistCm = s.holeDistCm || null;
  if (s.sticker) {                                     // find the same-coloured stickers again near the ball
    const near = { x: s.sticker.at[0] * S.W, y: s.sticker.at[1] * S.H };
    const pt = patch(near.x, near.y, S.ball.r * 25);
    if (pt) S.stickers = findStickers(pt, { hue: s.sticker.hue, area: s.sticker.area }, near, s.sticker.count);
  }
  setStage('putter');
  analyze();
});

$('btn-analyze').addEventListener('click', analyze);

// ---------------------------------------------------------------- analysis

function progress(t) {
  const f = Math.min(1, (t - S.tStart) / Math.max(0.1, video.duration - S.tStart));
  $('progress').querySelector('.bar > div').style.width = `${(f * 100).toFixed(0)}%`;
}

async function analyze() {
  if (S.stage !== 'putter') return;
  setStage('analyzing');
  const track = await followBall({
    ball: S.ball,
    tStart: S.tStart,
    duration: video.duration,
    frameAt: async (t) => { await seekTo(t); grabFrame(); return video.currentTime; },
    patch,
    onProgress: (t, tr) => { if (tr) S.track = tr; progress(t); draw({ live: work }); },
  });
  if (track.error) { S.track = null; return finish(track); }
  S.track = track;
  const st = settings.get();
  const res = analyzePutt({
    p0: { x: S.ball.x, y: S.ball.y }, r: S.ball.r, target: S.target,
    points: track.points, endReason: track.endReason, flip: st.flip,
    timeScale: st.slowmo, holeDistCm: S.holeDistCm,
  });
  if (!res.error && S.stickers.length) {
    setInstruction('Following the putter\u2026');
    const ts = st.slowmo;
    const impactT = res.speed?.impactT ?? track.points[0].t - 1 / 60;
    const frames = await followPutter({
      stickers: S.stickers,
      tFrom: Math.max(S.tStart, impactT - 2.5 * ts),
      tTo: Math.min(video.duration - 0.01, impactT + 0.8 * ts),
      frameAt: async (t) => { await seekTo(t); grabFrame(); return video.currentTime; },
      patch,
      onProgress: (t) => { progress(t); draw({ live: work }); },
    });
    S.stroke = analyzeStroke({ frames, u: res.aim, cmPerPx: res.cmPerPx, impactT, hand: st.hand, flip: st.flip, timeScale: ts });
  }
  finish(res);
}

function finish(res) {
  S.result = res;
  if (!res.error) {
    S.savedId = `${Date.now()}`;
    putts.add({
      id: S.savedId, date: new Date().toISOString(),
      angleDeg: res.angleDeg, missCm: res.missCm, distCm: res.distCm, onLine: res.onLine, finish: res.finish,
      launchMps: res.speed?.launchMps ?? null, stimpFt: res.speed?.stimpFt ?? null, paceCm: res.paceCm ?? null,
      stroke: S.stroke && !S.stroke.error ? {
        shape: S.stroke.shape, insideTopCm: S.stroke.insideTopCm, backCm: S.stroke.backCm, pathDeg: S.stroke.pathDeg,
        faceImpact: S.stroke.face?.impact ?? null, tempo: S.stroke.tempo?.ratio ?? null,
      } : null,
    });
    const sx = S.stickers;
    lastSetup.set({
      ball: [S.ball.x / S.W, S.ball.y / S.H],
      target: [S.target.x / S.W, S.target.y / S.H],
      snapped: S.target.snapped,
      holeDistCm: S.holeDistCm,
      sticker: sx.length ? {
        hue: sx[0].hue, area: sx[0].area, count: sx.length,
        at: [sx.reduce((q, o) => q + o.x, 0) / sx.length / S.W, sx.reduce((q, o) => q + o.y, 0) / sx.length / S.H],
      } : null,
    });
  }
  setStage('result');
  setInstruction(res.error ? res.error : 'Orange = the ball’s path. Green/red = its start line vs. your white aim line.', !!res.error);
  renderResult();
  seekTo(S.track ? S.track.restT : S.tStart).then(() => draw());
}

function renderResult() {
  const el = $('result');
  const res = S.result;
  const u = settings.get().units;
  el.hidden = false;
  if (res.error) {
    el.innerHTML = `<p class="muted">Nothing saved for this one.</p>`;
    $('btn-discard').hidden = true;
    return;
  }
  $('btn-discard').hidden = false;
  const reach = Math.abs(res.missCm) < 0.3
    ? 'dead center of the cup'
    : `${fmtLen(res.missCm, u)} ${res.missCm < 0 ? 'left' : 'right'} of center`;
  let finishTxt = 'Ball left the picture — finish not measured';
  if (res.finish?.kind === 'holed') finishTxt = 'Disappeared at the hole — probably holed 🎉';
  if (res.finish?.kind === 'stopped') {
    const { longCm, sideCm } = res.finish;
    finishTxt = `${fmtLen(longCm, u)} ${longCm >= 0 ? 'long' : 'short'}, ${fmtLen(sideCm, u)} ${sideCm < 0 ? 'left' : 'right'}`;
  }
  el.innerHTML = `
    <div class="verdict ${res.onLine ? 'good' : 'bad'}">
      <div class="big">${fmtAngle(res.angleDeg)}</div>
      <div class="tag">${res.onLine ? 'On line ✓' : 'Off line'}</div>
    </div>
    <dl class="facts">
      <dt>Putt length</dt><dd>${fmtLen(res.distCm, u)}</dd>
      <dt>Start line at the target</dt><dd>${reach}</dd>
      <dt>Finished</dt><dd>${finishTxt}</dd>
      ${speedRows(res, u)}
    </dl>
    <p class="muted small">On line = it would still catch the cup (within ${fmtLen(HOLE_RADIUS_CM, u)} of center) if the putt were straight.</p>
    ${strokeSection(u)}
    ${coverageNote(res, u)}`;
}

const fmtFace = (d) => (d == null ? '\u2014' : Math.abs(d) < 0.25 ? 'square' : `${Math.abs(d).toFixed(1)}\u00b0 ${d > 0 ? 'open' : 'closed'}`);
const fmtPath = (d) => (d == null ? '\u2014' : Math.abs(d) < 0.25 ? 'square' : `${Math.abs(d).toFixed(1)}\u00b0 ${d > 0 ? 'in-to-out' : 'out-to-in'}`);
const fmtSide = (cm, u) => (Math.abs(cm) < 0.3 ? 'on the line' : `${fmtLen(cm, u)} ${cm > 0 ? 'inside' : 'outside'}`);

function strokeSection(u) {
  const sk = S.stroke;
  if (!S.stickers.length) {
    return '<p class="hint small">Want stroke path, face angle and tempo? Put two bright dot stickers on top of your putter head (toe and heel) and tap them in step 3.</p>';
  }
  if (!sk || sk.error) return `<h3 class="section">Stroke</h3><p class="muted small">${sk?.error || 'Stroke not measured.'}</p>`;
  const f = sk.face;
  return `<h3 class="section">Stroke <span class="legend">cyan = putter path</span></h3>
    ${strokeChart(sk)}
    <dl class="facts">
      <dt>Path shape</dt><dd>${sk.shape}</dd>
      <dt>At the top</dt><dd>${fmtSide(sk.insideTopCm, u)} \u00b7 ${fmtLen(sk.backCm, u)} back</dd>
      <dt>Follow-through</dt><dd>${fmtSide(sk.insideThroughCm, u)} \u00b7 ${fmtLen(sk.throughCm, u)} through</dd>
      <dt>Path at impact</dt><dd>${fmtPath(sk.pathDeg)}</dd>
      ${f ? `<dt>Face at address</dt><dd>${fmtFace(f.address)}</dd>
      <dt>Face at the top</dt><dd>${fmtFace(f.top)}</dd>
      <dt>Face at impact</dt><dd><b>${fmtFace(f.impact)}</b></dd>` : '<dt>Face angle</dt><dd class="muted">needs 2 stickers</dd>'}
      ${sk.tempo ? `<dt>Tempo</dt><dd>${sk.tempo.backS.toFixed(2)} s back \u00b7 ${sk.tempo.fwdS.toFixed(2)} s through \u00b7 <b>${sk.tempo.ratio.toFixed(1)} : 1</b></dd>` : ''}
    </dl>
    <p class="muted small">Straight and arc strokes both work. What matters is doing it the same way every time, with the face square to the path at impact.</p>`;
}

// Top-down chart of the head's path vs. the aim line. Sideways is magnified (up to
// x6, shown on the chart) because a real arc is only a centimetre or two.
function strokeChart(sk) {
  const ser = sk.series;
  if (!ser?.length) return '';
  const W = 320, H = 150, pad = 18;
  const aMin = Math.min(...ser.map((p) => p.a)) - 2, aMax = Math.max(...ser.map((p) => p.a)) + 2;
  const k = (W - 2 * pad) / (aMax - aMin);
  const maxX = Math.max(0.5, ...ser.map((p) => Math.abs(p.x)));
  const MAG = Math.max(1, Math.min(6, Math.floor((H / 2 - 30) / (maxX * k))));
  const X = (a) => pad + (a - aMin) * k, Y = (x) => H / 2 - x * k * MAG;
  const d = ser.map((p, i) => `${i ? 'L' : 'M'}${X(p.a).toFixed(1)} ${Y(p.x).toFixed(1)}`).join(' ');
  const top = ser.find((p) => p.top), imp = ser.find((p) => p.imp), fin = ser[ser.length - 1];
  const mark = (p, label, anchor) => (p ? `<circle cx="${X(p.a)}" cy="${Y(p.x)}" r="3.5" class="c-mark"/>
    <text x="${X(p.a)}" y="${Math.min(H - 18, Y(p.x) + 15)}" text-anchor="${anchor}" class="c-txt">${label}</text>` : '');
  return `<svg class="stroke-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Putter path seen from above, sideways movement magnified">
    <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" class="c-aim"/>
    <text x="${W - 4}" y="${H / 2 - 5}" text-anchor="end" class="c-txt">aim line \u2192 target</text>
    <text x="4" y="12" class="c-txt">\u2191 inside (toward your feet)</text>
    <text x="4" y="${H - 4}" class="c-txt">\u2193 outside \u00b7 sideways \u00d7${MAG}</text>
    <path d="${d}" class="c-path"/>
    ${mark(top, 'top', 'start')}${mark(imp, 'impact', 'middle')}${mark(fin, 'finish', 'end')}
  </svg>`;
}

// How much of the putt line the picture covers, from the ball's known size.
function coverageNote(res, u) {
  const { x, y } = S.ball, a = res.aim;
  const ray = (dx, dy) => {
    let t = Infinity;
    if (dx > 0) t = Math.min(t, (S.W - x) / dx); if (dx < 0) t = Math.min(t, -x / dx);
    if (dy > 0) t = Math.min(t, (S.H - y) / dy); if (dy < 0) t = Math.min(t, -y / dy);
    return t * res.cmPerPx;
  };
  const ahead = ray(a.x, a.y), behind = ray(-a.x, -a.y);
  const tips = [];
  if (ahead < 90) tips.push('raise the phone (about 4 ft) so 3+ ft of roll fits \u2014 needed for green speed');
  if (S.stickers.length && behind < 30) tips.push('leave about a foot behind the ball so the whole backstroke fits');
  return `<p class="coverage small ${tips.length ? 'warn' : ''}">Picture covers ${fmtLen(behind, u)} behind the ball and ${fmtLen(ahead, u)} ahead.${tips.length ? ` Next time: ${tips.join('; ')}.` : ''}</p>`;
}

function speedRows(res, u) {
  const sp = res.speed;
  let rows = '';
  if (sp?.launchMps) rows += `<dt>Ball speed</dt><dd>${fmtSpeed(sp.launchMps, u)}</dd>`;
  rows += `<dt>Green speed (Stimp)</dt><dd>${sp?.stimpFt ? `${sp.stimpFt.toFixed(1)}` : '<span class="muted">needs ~3 ft of clean roll</span>'}</dd>`;
  if (res.paceCm != null) {
    const how = res.finish?.kind === 'stopped' ? '' : 'would stop ';
    rows += `<dt>Pace</dt><dd>${how}${fmtLen(res.paceCm, u)} ${res.paceCm >= 0 ? 'past' : 'short'} \u00b7 ${paceVerdict(res.paceCm)}</dd>`;
  }
  return rows;
}

$('btn-discard').addEventListener('click', () => {
  if (S.savedId) putts.remove(S.savedId);
  S.savedId = null;
  $('btn-discard').hidden = true;
  $('result').insertAdjacentHTML('beforeend', '<p class="muted small">Removed from your history.</p>');
});

$('btn-replay').addEventListener('click', async () => {
  if (!S.track || S.replaying) return;
  S.replaying = true;
  const end = (S.track.points.at(-1)?.t ?? S.tStart) + 0.8;
  const from = S.stroke?.path?.[0]?.t ?? S.track.restT;
  await seekTo(Math.max(0, Math.min(from, S.track.restT) - 0.5));
  video.playbackRate = 0.5;
  try { await video.play(); } catch { S.replaying = false; return; }
  const loop = () => {
    draw({ upTo: video.currentTime });
    if (!video.paused && !video.ended && video.currentTime < end) requestAnimationFrame(loop);
    else { video.pause(); S.replaying = false; draw(); }
  };
  requestAnimationFrame(loop);
});

$('btn-new').addEventListener('click', () => $('file').click());

// ---------------------------------------------------------------- picking a video

$('file').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  if (video.src.startsWith('blob:')) URL.revokeObjectURL(video.src);
  loadVideo(URL.createObjectURL(f));
  e.target.value = '';
});
$('btn-demo').addEventListener('click', () => loadVideo('demo/putt-demo.mp4'));

// ---------------------------------------------------------------- history + settings

function renderHistory() {
  const u = settings.get().units;
  const all = putts.all();
  const today = new Date().toDateString();
  const todays = all.filter((p) => new Date(p.date).toDateString() === today);
  const card = (title, s) => s ? `
    <div class="stat-card"><h3>${title}</h3>
      <div class="stats">
        <div><b>${s.n}</b><span>putts</span></div>
        <div><b>${s.onLinePct.toFixed(0)}%</b><span>on line</span></div>
        <div><b>${s.within1Pct.toFixed(0)}%</b><span>within 1°</span></div>
        <div><b>${s.avgAbs.toFixed(1)}°</b><span>avg miss</span></div>
      </div>
      <p class="small">${Math.abs(s.bias) < 0.2 ? 'No left/right tendency.' : `You tend to start it <b>${Math.abs(s.bias).toFixed(1)}° ${s.bias < 0 ? 'left' : 'right'}</b>.`}</p>
    </div>` : '';
  $('stats').innerHTML = all.length
    ? speedCard(greenSpeed(todays)) + card('Today', summarize(todays)) + strokeCard(todays, u) + card('All time', summarize(all))
    : '<p class="muted">No putts yet. Analyze one and it shows up here.</p>';
  $('list').innerHTML = all.map((p) => `
    <li><span class="dot ${p.onLine ? 'good' : 'bad'}"></span>
      <span class="grow"><b>${fmtAngle(p.angleDeg)}</b> · ${fmtLen(p.distCm, u)}
      <span class="muted small">${new Date(p.date).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></span>
      <button class="x" data-id="${p.id}" aria-label="Delete">×</button></li>`).join('');
  $('btn-clear').hidden = !all.length;
  const st = settings.get();
  $('set-units').value = st.units;
  $('set-flip').checked = st.flip;
  $('set-slowmo').value = String(st.slowmo);
  $('set-hand').value = st.hand;
}

function strokeCard(list, u) {
  const sk = list.map((p) => p.stroke).filter(Boolean);
  if (!sk.length) return '';
  const avg = (k) => { const v = sk.map((s) => s[k]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const shapes = {};
  for (const s of sk) shapes[s.shape] = (shapes[s.shape] || 0) + 1;
  const common = Object.entries(shapes).sort((a, b) => b[1] - a[1])[0][0];
  const face = avg('faceImpact'), path = avg('pathDeg'), tempo = avg('tempo'), inside = avg('insideTopCm');
  return `<div class="stat-card"><h3>Stroke today</h3>
    <dl class="facts">
      <dt>Usual shape</dt><dd>${common} (${shapes[common]} of ${sk.length})</dd>
      ${inside != null ? `<dt>Avg at the top</dt><dd>${fmtSide(inside, u)}</dd>` : ''}
      ${face != null ? `<dt>Avg face at impact</dt><dd>${fmtFace(face)}</dd>` : ''}
      ${path != null ? `<dt>Avg path at impact</dt><dd>${fmtPath(path)}</dd>` : ''}
      ${tempo != null ? `<dt>Avg tempo</dt><dd>${tempo.toFixed(1)} : 1</dd>` : ''}
    </dl></div>`;
}

$('list').addEventListener('click', (e) => {
  const id = e.target.dataset?.id;
  if (id) { putts.remove(id); renderHistory(); }
});
$('btn-clear').addEventListener('click', () => {
  if (confirm('Delete every saved putt on this phone?')) { putts.clear(); renderHistory(); }
});
$('set-units').addEventListener('change', (e) => { settings.set({ units: e.target.value }); renderHistory(); if (S.result) renderResult(); });
$('set-flip').addEventListener('change', (e) => settings.set({ flip: e.target.checked }));
$('set-slowmo').addEventListener('change', (e) => settings.set({ slowmo: Number(e.target.value) }));
$('set-hand').addEventListener('change', (e) => settings.set({ hand: e.target.value }));

function speedCard(g) {
  if (!g) return '';
  const spread = g.n > 1 ? ` <span class="muted small">(range ${g.min.toFixed(1)}\u2013${g.max.toFixed(1)})</span>` : '';
  return `<div class="stat-card"><h3>Green speed today</h3>
    <div class="stimp"><b>${g.avg.toFixed(1)}</b> on the Stimpmeter${spread}</div>
    <p class="small muted">Average of ${g.n} putt${g.n > 1 ? 's' : ''}. For an honest number, hit putts both ways on the same line (uphill and downhill cancel out).</p>
  </div>`;
}

for (const b of document.querySelectorAll('nav button')) {
  b.addEventListener('click', () => {
    for (const o of document.querySelectorAll('nav button')) o.classList.toggle('active', o === b);
    $('tab-putt').hidden = b.dataset.tab !== 'putt';
    $('tab-history').hidden = b.dataset.tab !== 'history';
    if (b.dataset.tab === 'history') renderHistory();
  });
}

// ---------------------------------------------------------------- boot

const demo = new URLSearchParams(location.search).get('demo');
if (demo) loadVideo(demo);

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
