// Putter stroke: follows 1-2 coloured stickers on the putter head, then measures
// the path shape (straight vs arc), path direction at impact, face angle and tempo.
// Pure logic: frames come from the caller (browser or Node test).
import { stickerBlobs } from './tracker.js';

// stickers: [{ x, y, area, r, hue }] at time tFrom (or nearby).
// Returns [{ t, pts: [{x,y}|null, ...] }], one entry per analysed frame.
export async function followPutter({ stickers, tFrom, tTo, step = 1 / 60, frameAt, patch, onProgress = () => {} }) {
  const st = stickers.map((s) => ({ ...s, last: { x: s.x, y: s.y }, vel: { x: 0, y: 0 }, lost: 0 }));
  const frames = [];
  let first = true;
  for (let t = tFrom; t <= tTo + 1e-9; t += step) {
    const ft = await frameAt(t);
    const preds = st.map((s) => ({ x: s.last.x + s.vel.x * (s.lost + 1), y: s.last.y + s.vel.y * (s.lost + 1) }));
    const Rs = st.map((s) => (first || s.lost > 6
      ? s.r * 16
      : Math.min(s.r * 30, Math.max(s.r * 5, Math.hypot(s.vel.x, s.vel.y) * (2 + s.lost) + s.r * 4))));
    // One patch covering every sticker's search circle.
    const x0 = Math.min(...preds.map((p, k) => p.x - Rs[k])), x1 = Math.max(...preds.map((p, k) => p.x + Rs[k]));
    const y0 = Math.min(...preds.map((p, k) => p.y - Rs[k])), y1 = Math.max(...preds.map((p, k) => p.y + Rs[k]));
    const pt = patch((x0 + x1) / 2, (y0 + y1) / 2, Math.max(x1 - x0, y1 - y0) / 2);
    const cands = st.map((s, k) => (pt ? stickerBlobs(pt, s.hue) : [])
      .filter((b) => b.area / s.area > 0.3 && b.area / s.area < 3.5)
      .map((b) => ({ ...b, d: Math.hypot(b.x - preds[k].x, b.y - preds[k].y) }))
      .filter((b) => b.d <= Rs[k]));
    const pick = assign(cands, Rs);
    st.forEach((s, k) => {
      const b = pick[k];
      if (!b) { s.lost++; return; }
      const nv = { x: b.x - s.last.x, y: b.y - s.last.y };
      s.vel = s.lost ? { x: nv.x / (s.lost + 1), y: nv.y / (s.lost + 1) } : { x: 0.5 * nv.x + 0.5 * s.vel.x, y: 0.5 * nv.y + 0.5 * s.vel.y };
      s.last = { x: b.x, y: b.y };
      s.lost = 0;
    });
    frames.push({ t: ft, pts: pick.map((b) => (b ? { x: b.x, y: b.y } : null)) });
    first = false;
    onProgress(t, frames);
  }
  return frames;
}

// Give each sticker its own blob (never the same blob twice), cheapest total distance.
function assign(cands, Rs) {
  if (cands.length === 1) {
    const best = cands[0].reduce((a, b) => (!a || b.d < a.d ? b : a), null);
    return [best];
  }
  let best = [null, null], bestCost = 3;               // 3 = both missing
  const opts0 = [null, ...cands[0]], opts1 = [null, ...cands[1]];
  for (const a of opts0) for (const b of opts1) {
    if (a && b && a.x === b.x && a.y === b.y) continue;
    const cost = (a ? a.d / Rs[0] : 1.5) + (b ? b.d / Rs[1] : 1.5);
    if (cost < bestCost) { bestCost = cost; best = [a, b]; }
  }
  return best;
}

function polyfit(xs, ys, deg) {
  const n = deg + 1, M = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  for (let k = 0; k < xs.length; k++) {
    const pw = [1]; for (let i = 1; i < 2 * n; i++) pw.push(pw[i - 1] * xs[k]);
    for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) M[i][j] += pw[i + j]; M[i][n] += pw[i] * ys[k]; }
  }
  for (let i = 0; i < n; i++) {
    let m = i; for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[m][i])) m = k;
    [M[i], M[m]] = [M[m], M[i]];
    if (Math.abs(M[i][i]) < 1e-12) return null;
    for (let k = 0; k < n; k++) if (k !== i) { const f = M[k][i] / M[i][i]; for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j]; }
  }
  return M.map((row, i) => row[n] / row[i]);
}

function signedAngle(ax, ay, bx, by) {
  return (Math.atan2(ax * by - ay * bx, ax * bx + ay * by) * 180) / Math.PI;
}

// frames: from followPutter. u: unit aim direction (image coords). cmPerPx: scale.
// impactT: video time of impact. hand: 'right' | 'left'. flip: mirrored video.
export function analyzeStroke({ frames, u, cmPerPx, impactT, hand = 'right', flip = false, timeScale = 1 }) {
  const mirror = flip ? -1 : 1;
  const rn = { x: -u.y, y: u.x };                                   // right of the aim line, seen from above
  const insideSign = (hand === 'right' ? -1 : 1) * mirror;          // right-handers stand LEFT of the line
  const openSign = (hand === 'right' ? 1 : -1) * mirror;            // right-hander: face aimed right = open

  // Head centre each frame. With one sticker missing, use the last known toe-heel offset.
  const two = frames.some((f) => f.pts.length === 2);
  let off = null;
  const samples = [];
  for (const f of frames) {
    const [a, b] = f.pts;
    let c = null, face = null;
    if (a && b) {
      off = { x: b.x - a.x, y: b.y - a.y };
      c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      let nx = -off.y, ny = off.x;                                    // face normal, pointing at the target
      if (nx * u.x + ny * u.y < 0) { nx = -nx; ny = -ny; }
      face = openSign * signedAngle(u.x, u.y, nx, ny);
    } else if (a && (!two || off)) c = two ? { x: a.x + off.x / 2, y: a.y + off.y / 2 } : a;
    else if (b && off) c = { x: b.x - off.x / 2, y: b.y - off.y / 2 };
    if (c) samples.push({ t: f.t, c, face });
  }
  if (samples.length < 8) return { error: 'Couldn’t follow the putter stickers through the stroke.' };

  const A = (s) => (s.c.x * u.x + s.c.y * u.y) * cmPerPx;                 // along the line, cm (+ toward target)
  const X = (s) => insideSign * (s.c.x * rn.x + s.c.y * rn.y) * cmPerPx;   // across, cm (+ toward your feet)

  let imp = 0;
  samples.forEach((s, i) => { if (Math.abs(s.t - impactT) < Math.abs(samples[imp].t - impactT)) imp = i; });
  let top = 0;
  for (let i = 0; i <= imp; i++) if (A(samples[i]) < A(samples[top])) top = i;
  let aMax = -Infinity;
  for (let i = 0; i <= top; i++) aMax = Math.max(aMax, A(samples[i]));
  const roughLen = aMax - A(samples[top]);
  if (roughLen < 3) return { error: 'The putter barely moved — was the backstroke in the picture?' };
  // Takeaway: the last moment the head was still at address (within 1.5 mm / 1%).
  const startTol = Math.max(0.15, 0.01 * roughLen);
  let start = 0;
  for (let i = 0; i < top; i++) if (A(samples[i]) >= aMax - startTol) start = i;
  let fin = imp;
  for (let i = imp + 1; i < samples.length; i++) if (A(samples[i]) > A(samples[fin])) fin = i;

  // Address position = median of the still frames before the takeaway.
  const median = (v) => { const q = [...v].sort((p, r) => p - r); return q.length ? q[q.length >> 1] : null; };
  const still = samples.slice(0, start + 1).filter((s) => A(s) >= aMax - Math.max(0.3, 0.03 * roughLen));
  const a0 = median(still.map(A)), x0 = median(still.map(X));
  const backCm = a0 - A(samples[top]);
  const throughCm = A(samples[fin]) - a0;
  const insideTopCm = X(samples[top]) - x0;
  const insideThroughCm = X(samples[fin]) - x0;

  // Path at impact: curve through the head positions around impact, slope at impact.
  const win = samples.filter((s) => Math.abs(s.t - impactT) <= 0.1 * timeScale);
  let pathDeg = null;
  if (win.length >= 4) {
    const q = polyfit(win.map(A), win.map(X), 2);
    const aImp = A(samples[imp]);
    if (q) pathDeg = (-Math.atan(q[1] + 2 * q[2] * aImp) * 180) / Math.PI;   // + = in-to-out
  }

  // Face: averaged over neighbouring frames to beat pixel noise.
  const faceSamples = (t0, w) => samples.filter((s) => s.face != null && Math.abs(s.t - t0) <= w * timeScale);
  const mean = (v) => (v.length ? v.reduce((p, r) => p + r, 0) / v.length : null);
  const faceAtImpact = () => {
    const fs = faceSamples(impactT, 0.05);
    if (fs.length < 3) return mean(fs.map((s) => s.face));
    const q = polyfit(fs.map((s) => s.t - impactT), fs.map((s) => s.face), 1);
    return q ? q[0] : mean(fs.map((s) => s.face));
  };
  const tTop = samples[top].t;
  // Takeaway time: early in the backstroke the head speeds up smoothly from rest,
  // so drop-from-address grows like (t - t0)^2. A straight line through sqrt(drop)
  // finds t0 between frames instead of waiting for it to pass a threshold.
  let tTake = samples[start].t;
  const early = samples.slice(start + 1, top)
    .map((s) => ({ t: s.t, d: a0 - A(s) }))
    .filter((p) => p.d >= 0.1 && p.d <= 0.25 * backCm);
  if (early.length >= 3) {
    const q = polyfit(early.map((p) => p.t), early.map((p) => Math.sqrt(p.d)), 1);
    if (q && q[1] > 0) { const t0 = -q[0] / q[1]; if (t0 > samples[start].t - 0.15 * timeScale && t0 < early[0].t) tTake = t0; }
  }
  const backS = (tTop - tTake) / timeScale;
  const fwdS = (impactT - tTop) / timeScale;

  const tol = Math.max(0.6, 0.06 * backCm);
  let shape;
  if (Math.abs(insideTopCm) <= tol) shape = 'Straight back';
  else if (insideTopCm > 0) shape = insideTopCm <= 0.15 * backCm ? 'Slight arc' : 'Strong arc';
  else shape = 'Goes outside on the way back';

  return {
    shape,
    backCm, throughCm, insideTopCm, insideThroughCm, pathDeg,
    face: two ? {
      address: median(still.filter((s) => s.face != null).map((s) => s.face)),
      top: mean(faceSamples(samples[top].t, 0.04).map((s) => s.face)),
      impact: faceAtImpact(),
    } : null,
    tempo: backS > 0 && fwdS > 0 ? { backS, fwdS, ratio: backS / fwdS } : null,
    path: samples.slice(start, fin + 1).map((s) => ({ t: s.t, x: s.c.x, y: s.c.y })),
    // Same path in cm relative to address: a = along (+ toward target), x = inside (+ toward your feet).
    series: samples.slice(start, fin + 1).map((s) => ({ a: A(s) - a0, x: X(s) - x0, top: s === samples[top], imp: s === samples[imp] })),
    address: samples[start].c,
    impactLine: (() => {                                              // face line at impact, for drawing
      const f = frames.find((fr) => Math.abs(fr.t - samples[imp].t) < 1e-6);
      return f && f.pts[0] && f.pts[1] ? f.pts : null;
    })(),
  };
}
