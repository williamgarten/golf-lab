// Clock-drill maths for wedges, filmed face-on (camera in front of the golfer).
// Pure logic: the caller supplies body landmarks (MediaPipe Pose: 33 points,
// x/y as fractions of the picture), so the same code runs in the browser and in
// the Node test (tools/test-clock.mjs).
//
// The lead arm is the clock hand: shoulder to hands. Arm straight down = 6:00,
// parallel to the ground going back = 9:00, straight up = 12:00. The follow-through
// is counted as a mirror image, so "9 to 9" means the same length both ways
// (some coaches call that "9 to 3").

const L_SHOULDER = 11, R_SHOULDER = 12, L_WRIST = 15, R_WRIST = 16, L_HIP = 23, R_HIP = 24;
const MIN_VIS = 0.5;

// Lead-arm angle in degrees from straight down: + = going back (away from the
// target), - = through. hand: 'right' | 'left'. flip: selfie camera (mirrored).
export function armAngle(lm, W, H, hand = 'right', flip = false) {
  if (!lm) return null;
  const sh = lm[hand === 'left' ? R_SHOULDER : L_SHOULDER];
  if (!sh || (sh.v ?? 1) < MIN_VIS) return null;
  // Hands are together on the grip: average the wrists we can see.
  let hx = 0, hy = 0, n = 0;
  for (const i of [L_WRIST, R_WRIST]) {
    const p = lm[i];
    if (p && (p.v ?? 1) >= MIN_VIS) { const w = p.v ?? 1; hx += p.x * w; hy += p.y * w; n += w; }
  }
  if (!n) return null;
  const vx = (hx / n - sh.x) * W, vy = (hy / n - sh.y) * H;
  if (Math.hypot(vx, vy) < 0.04 * Math.max(W, H)) return null;
  // Facing the camera, a right-hander's backswing goes to the picture's left.
  const back = (hand === 'left') !== flip ? 1 : -1;
  return (Math.atan2(back * vx, vy) * 180) / Math.PI;
}

// Is the whole golfer in the picture and facing the camera?
export function bodyCheck(lm, W, H) {
  if (!lm) return { inFrame: false, facing: null };
  const need = [11, 12, 15, 16, 23, 24, 27, 28];
  const inFrame = need.every((i) => lm[i] && (lm[i].v ?? 1) >= MIN_VIS && lm[i].x > 0.01 && lm[i].x < 0.99 && lm[i].y > 0.01 && lm[i].y < 0.99);
  const sw = Math.abs(lm[L_SHOULDER].x - lm[R_SHOULDER].x) * W;
  const torso = Math.abs((lm[L_HIP].y + lm[R_HIP].y) / 2 - (lm[L_SHOULDER].y + lm[R_SHOULDER].y) / 2) * H;
  // Face-on the shoulders look wide; from down the line they overlap.
  const facing = torso > 0 ? sw / torso > 0.55 : null;
  return { inFrame, facing };
}

export const toHour = (deg) => 6 + deg / 30;            // 90 deg -> 9:00
export function fmtClock(h) {
  if (h == null || !Number.isFinite(h)) return '–';
  let mins = Math.round((h * 60) / 5) * 5;               // nearest 5 minutes
  let hh = Math.floor(mins / 60), mm = mins - hh * 60;
  hh = ((hh - 1) % 12 + 12) % 12 + 1;
  return `${hh}:${String(mm).padStart(2, '0')}`;
}
// The through position as it reads on a real clock face (mirror of 9:00 is 3:00).
export const faceHour = (mirrored) => 12 - mirrored;

// samples: [{ t, deg }] in time order (deg from armAngle, null when not seen).
// Returns { takeawayT, topT, impactT, finishT, back, through, tempo } or { error }.
export function analyzeClock(samples) {
  const s = unwrap(samples.filter((p) => p.deg != null && Number.isFinite(p.deg)));
  if (s.length < 8) return { error: 'Couldn’t see your arms well enough. Make sure your whole body is in the picture.' };
  const d = smooth(s.map((p) => p.deg));
  const t = s.map((p) => p.t);

  // Top of the backswing: the biggest "back" angle that is followed by a swing through.
  let top = -1;
  for (let i = 1; i < d.length - 1; i++) {
    if (d[i] < 20) continue;
    if (top >= 0 && d[i] <= d[top]) continue;
    let thru = false;
    for (let j = i + 1; j < d.length; j++) if (d[j] < -10) { thru = true; break; }
    if (thru) top = i;
  }
  if (top < 0) return { error: 'Didn’t see a full swing (back and through).' };

  // Impact: the arm passes straight down again.
  let imp = -1;
  for (let i = top + 1; i < d.length; i++) if (d[i] <= 0) { imp = i; break; }
  if (imp < 0) return { error: 'Didn’t see the swing come through.' };
  const impactT = cross(t, d, imp, 0);

  // Finish: furthest point through before the arm comes back down (or the clip ends).
  let fin = imp;
  for (let i = imp + 1; i < d.length; i++) {
    if (d[i] < d[fin]) fin = i;
    else if (d[i] > d[fin] + 20) break;                     // coming back down
  }

  const raw = s.map((p) => p.deg);
  const peak = turnPoint(t, d, raw, top), low = turnPoint(t, d, raw, fin);

  // Takeaway: the arm leaves address slowly, so a threshold fires late. The early
  // backswing grows like (time since takeaway)^2, so sqrt(angle - address) is a
  // straight line in time; where that line hits zero is the takeaway.
  let a0 = 0;
  for (let i = top; i >= 0; i--) if (d[i] < 6) { a0 = i; break; }
  // Step back from there to where the arm was still (address), then take its angle.
  let j = a0;
  const back = (i) => { let k = i; while (k > 0 && t[i] - t[k] < 0.1) k--; return k; };
  while (j > 0) { const k = back(j); if ((d[j] - d[k]) / Math.max(1e-3, t[j] - t[k]) < 12) break; j = k; }
  const still = []; for (let i = j; i >= 0 && t[j] - t[i] <= 0.3; i--) still.push(d[i]);
  const addr = median(still);
  const amp = peak.v - addr;
  const fx = [], fy = [];
  for (let i = a0; i <= top; i++) {
    const rise = d[i] - addr;
    if (rise >= 0.02 * amp && rise <= 0.15 * amp) { fx.push(t[i]); fy.push(Math.sqrt(rise)); }
  }
  let takeawayT;
  if (fx.length >= 2) {
    const { m, c } = linfit(fx, fy);
    takeawayT = m > 0 ? -c / m : fx[0];
  } else {
    let tk = a0;
    for (let i = top; i > 0; i--) if (d[i] <= addr + 0.05 * amp) { tk = i; break; }
    takeawayT = t[tk];
  }

  const backDeg = peak.v, thruDeg = -low.v;
  const backS = peak.t - takeawayT, downS = impactT - peak.t;
  return {
    takeawayT, topT: peak.t, impactT, finishT: low.t,
    back: { deg: backDeg, hour: toHour(backDeg) },
    through: { deg: thruDeg, hour: toHour(thruDeg) },
    tempo: backS > 0 && downS > 0 ? { backS, downS, ratio: backS / downS } : null,
  };
}

// How a position compares with the target: minutes long (+) or short (-).
export function vsTarget(hour, target) {
  if (target == null) return null;
  const mins = (hour - target) * 60;
  return { mins, ok: Math.abs(mins) <= 10 };
}
export function sayVs(v) {
  if (!v) return '';
  if (v.ok) return 'right on';
  const m = Math.round(Math.abs(v.mins) / 5) * 5, h = Math.floor(m / 60), r = m % 60;
  const amt = !h ? `${m} minutes` : `${h === 1 ? 'an hour' : `${h} hours`}${r === 30 ? ' and a half' : r ? ` ${r}` : ''}`;
  return `${amt} ${v.mins > 0 ? 'long' : 'short'}`;
}

// ---------------------------------------------------------------- helpers

function unwrap(s) {
  const out = [];
  let off = 0, prev = null;
  for (const p of s) {
    let v = p.deg + off;
    if (prev != null) {
      while (v - prev > 180) { off -= 360; v -= 360; }
      while (prev - v > 180) { off += 360; v += 360; }
    }
    out.push({ t: p.t, deg: v }); prev = v;
  }
  return out;
}
function smooth(a) {
  const m = a.map((_, i) => median(a.slice(Math.max(0, i - 1), i + 2)));
  return m.map((_, i) => { const w = m.slice(Math.max(0, i - 1), i + 2); return w.reduce((q, v) => q + v, 0) / w.length; });
}
function linfit(x, y) {
  const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
  const m = sxx ? sxy / sxx : 0;
  return { m, c: my - m * mx };
}
function median(a) { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; }
function cross(t, d, i, level) {
  if (i <= 0) return t[0];
  const f = (level - d[i - 1]) / ((d[i] - d[i - 1]) || 1e-9);
  return t[i - 1] + Math.max(0, Math.min(1, f)) * (t[i] - t[i - 1]);
}
// Top / finish: the time is where the arm's speed passes through zero (between
// samples); the angle is a small least-squares parabola through the raw samples
// there, so smoothing doesn't shave the peak off.
function turnPoint(t, d, raw, i) {
  // Lightly smoothed (3-sample mean, no median): heavier smoothing drags an uneven
  // peak (slow going up, fast coming down) early.
  const m = raw.map((_, k) => (raw[Math.max(0, k - 1)] + raw[k] + raw[Math.min(raw.length - 1, k + 1)]) / 3);
  const sign = Math.sign(d[i] - median(d)) || 1;
  for (const k of [i - 1, i + 1]) if (k > 0 && k < d.length - 1 && sign * m[k] > sign * m[i]) i = k;
  // Time = the sample at the peak. (Interpolating between samples is biased when
  // the arm goes up slowly and comes down fast, so this is ±half a frame, unbiased.)
  const tt = t[i];
  const w = [];
  for (let j = Math.max(0, i - 3); j <= Math.min(d.length - 1, i + 3); j++) if (Math.abs(t[j] - tt) <= 0.08) w.push(j);
  if (w.length < 3) return { t: tt, v: raw[i] };
  // fit raw = a + b(x) + c(x)^2 with x = t - tt
  let S = [0, 0, 0, 0, 0], R = [0, 0, 0];
  for (const j of w) { const x = t[j] - tt; for (let k = 0; k < 5; k++) S[k] += x ** k; for (let k = 0; k < 3; k++) R[k] += raw[j] * x ** k; }
  const M = [[S[0], S[1], S[2]], [S[1], S[2], S[3]], [S[2], S[3], S[4]]];
  const sol = solve3(M, R);
  if (!sol) return { t: tt, v: raw[i] };
  const [a, b, c] = sol;
  const xv = c ? Math.max(-0.05, Math.min(0.05, -b / (2 * c))) : 0;
  return { t: tt, v: a + b * xv + c * xv * xv };
}
function solve3(M, R) {
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(M);
  if (Math.abs(D) < 1e-18) return null;
  return [0, 1, 2].map((k) => det(M.map((row, r) => row.map((v, c) => (c === k ? R[r] : v)))) / D);
}

// Peak of a parabola through the three samples around i (sub-frame top / finish).
function vertex(t, d, i) {
  if (i <= 0 || i >= d.length - 1) return { t: t[i], v: d[i] };
  const y0 = d[i - 1], y1 = d[i], y2 = d[i + 1];
  const den = y0 - 2 * y1 + y2;
  if (Math.abs(den) < 1e-9) return { t: t[i], v: y1 };
  const k = Math.max(-1, Math.min(1, (0.5 * (y0 - y2)) / den));
  const v = y1 - 0.25 * (y0 - y2) * k;
  const tt = k < 0 ? t[i] + k * (t[i] - t[i - 1]) : t[i] + k * (t[i + 1] - t[i]);
  return { t: tt, v };
}
