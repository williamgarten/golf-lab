// Start-line math. Positions are in frame pixels, image y points DOWN.
// The ball's known size (42.67 mm) gives us the real-world scale.

export const BALL_DIAMETER_CM = 4.267;
export const HOLE_RADIUS_CM = 5.4;   // regulation hole is 10.8 cm across
const START_WINDOW_CM = 40;          // judge the start line over the first ~16 inches

// Signed angle (degrees) from vector a to vector b. Seen from above,
// negative = b is LEFT of a, positive = RIGHT (for y-down image coords).
function signedAngle(ax, ay, bx, by) {
  const cross = ax * by - ay * bx;
  const dot = ax * bx + ay * by;
  return (Math.atan2(cross, dot) * 180) / Math.PI;
}

// p0: ball at rest {x,y}; r: ball radius px; target: aim point {x,y};
// points: [{t,x,y}] after the ball started moving; endReason: 'stopped'|'lost'|'video-end'.
// holeDistCm: typed-in hole distance when the hole isn't in the picture (target = a point on the line).
// target.virtual: no hole tapped, just "toward the top of the picture" (distance unknown
// unless holeDistCm is typed in).
export function analyzePutt({ p0, r, target, points, endReason, flip = false, timeScale = 1, holeDistCm = null }) {
  const cmPerPx = BALL_DIAMETER_CM / (2 * r);
  const ax = target.x - p0.x, ay = target.y - p0.y;
  const aimPx = Math.hypot(ax, ay);
  if (aimPx < 4 * r) return { error: 'The aim point is too close to the ball. Tap the hole or a point further along your line.' };
  const ux = ax / aimPx, uy = ay / aimPx;

  // Start direction = average direction of the ball over the first ~40 cm.
  const windowPx = START_WINDOW_CM / cmPerPx;
  let sx = 0, sy = 0, used = 0;
  for (const p of points) {
    const dx = p.x - p0.x, dy = p.y - p0.y, d = Math.hypot(dx, dy);
    if (d < r) continue;
    if (d > windowPx && used >= 3) break;
    sx += dx; sy += dy; used++;
  }
  if (used < 2) return { error: 'Couldn’t follow the ball long enough. Make sure the first couple of feet of the roll are in the picture.' };

  const sign = flip ? -1 : 1;
  const angleDeg = sign * signedAngle(ux, uy, sx, sy);
  const distCm = holeDistCm || (target.virtual ? null : aimPx * cmPerPx);
  const missCm = distCm ? distCm * Math.tan((angleDeg * Math.PI) / 180) : null;
  const startLen = Math.hypot(sx, sy);

  const result = {
    angleDeg,
    distCm,
    missCm,
    // Without a distance, "on line" falls back to starting within 1 degree.
    onLine: missCm != null ? Math.abs(missCm) <= HOLE_RADIUS_CM : Math.abs(angleDeg) <= 1,
    startDir: { x: sx / startLen, y: sy / startLen },
    aim: { x: ux, y: uy },
    pointsUsed: used,
    cmPerPx,
    endReason,
    finish: null,
  };

  // Where it finished, relative to the target.
  const last = points[points.length - 1];
  if (last) {
    const dx = last.x - target.x, dy = last.y - target.y;
    const nearHole = !holeDistCm && !target.virtual && Math.hypot(dx, dy) * cmPerPx <= HOLE_RADIUS_CM * 2;
    const alongCm = ((last.x - p0.x) * ux + (last.y - p0.y) * uy) * cmPerPx;
    if (endReason === 'stopped') {
      result.finish = {
        kind: 'stopped',
        longCm: distCm ? alongCm - distCm : null,              // + past the hole, - short
        sideCm: sign * (ux * dy - uy * dx) * cmPerPx,          // + right, - left
      };
    } else if (nearHole) {
      result.finish = { kind: 'holed' };
    }
  }
  result.speed = measureSpeed({ p0, points, cmPerPx, r, timeScale, stopped: endReason === 'stopped' });
  // Pace: where the ball stops (measured, or predicted from its slowdown) vs. the target.
  if (!distCm) result.paceCm = null;
  else if (result.finish?.kind === 'stopped') result.paceCm = result.finish.longCm;
  else if (result.speed?.stopCm != null && result.finish?.kind !== 'holed') result.paceCm = result.speed.stopCm - distCm;
  return result;
}

// --- speed & green speed --------------------------------------------------

const STIMP_RELEASE_MPS = 1.83;   // a Stimpmeter ramp releases the ball at ~6.0 ft/s
const SKID_CM = 30;               // ignore the first ~1 ft: the ball skids before it truly rolls

// Least-squares polynomial fit (degree 1 or 2). Returns coefficients [c0, c1, c2?].
function polyfit(xs, ys, deg) {
  const n = deg + 1, A = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  for (let k = 0; k < xs.length; k++) {
    const pw = [1]; for (let i = 1; i < 2 * n; i++) pw.push(pw[i - 1] * xs[k]);
    for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) A[i][j] += pw[i + j]; A[i][n] += pw[i] * ys[k]; }
  }
  for (let i = 0; i < n; i++) {                       // Gauss-Jordan
    let m = i; for (let k = i + 1; k < n; k++) if (Math.abs(A[k][i]) > Math.abs(A[m][i])) m = k;
    [A[i], A[m]] = [A[m], A[i]];
    if (Math.abs(A[i][i]) < 1e-12) return null;
    for (let k = 0; k < n; k++) if (k !== i) { const f = A[k][i] / A[i][i]; for (let j = i; j <= n; j++) A[k][j] -= f * A[i][j]; }
  }
  return A.map((row, i) => row[n] / row[i]);
}

// Ball speed off the face, deceleration while rolling, and the Stimp reading that implies.
// On a flat green a rolling ball slows at a steady rate a, and a Stimpmeter
// ball (released at 1.83 m/s) would roll 1.83^2 / (2a) metres.
export function measureSpeed({ p0, points, cmPerPx, r, timeScale = 1, stopped }) {
  if (points.length < 4) return null;
  const t0 = points[0].t;
  const ts = points.map((p) => (p.t - t0) / timeScale);
  const ss = points.map((p) => Math.hypot(p.x - p0.x, p.y - p0.y) * cmPerPx / 100);  // metres from start

  // Launch speed: curve through the first few positions, read at the first one
  // (the skidding ball loses speed fast, so averaging would under-read it).
  // Impact happened just before the first sighting: back up by (distance so far / speed).
  let k = 4; while (k < ts.length && ts[k] < 0.07) k++;
  const fit = polyfit(ts.slice(0, k), ss.slice(0, k), 2);
  let launch = null, sinceImpact = 0;
  if (fit && fit[1] > 0) {
    sinceImpact = Math.min(0.05, Math.max(0, ss[0] / fit[1]));
    launch = fit[1] - 2 * Math.min(0, fit[2]) * sinceImpact;
  }
  // impactT: video time of impact (used to line up the putter stroke).
  const out = { launchMps: launch, decelMps2: null, stimpFt: null, stopCm: null, rollSecs: null, impactT: t0 - sinceImpact * timeScale };

  // Rolling phase: after the skid, until it comes to rest.
  const sEnd = ss[ss.length - 1];
  let end = ss.length;
  if (stopped) { end = ss.findIndex((s) => s >= sEnd - (0.3 * r * cmPerPx) / 100) + 1; }
  const idx = [];
  for (let i = 0; i < end; i++) if (ss[i] * 100 >= SKID_CM) idx.push(i);
  if (idx.length < 6) return out;
  const tr = idx.map((i) => ts[i]), sr = idx.map((i) => ss[i]);
  out.rollSecs = tr[tr.length - 1] - tr[0];
  if (out.rollSecs < 0.4) return out;
  const q = polyfit(tr, sr, 2);
  if (!q || q[2] >= 0) return out;                    // not slowing down: downhill or bad track
  const a = -2 * q[2];
  out.decelMps2 = a;
  const stimpFt = (STIMP_RELEASE_MPS ** 2) / (2 * a) / 0.3048;
  if (stimpFt >= 4 && stimpFt <= 18) out.stimpFt = stimpFt;
  if (!stopped) {
    const tl = tr[tr.length - 1], vLast = q[1] + 2 * q[2] * tl;
    out.stopCm = vLast > 0 ? (sr[sr.length - 1] + vLast * vLast / (2 * a)) * 100 : sr[sr.length - 1] * 100;
  }
  return out;
}

export function greenSpeed(putts) {
  const v = putts.map((p) => p.stimpFt).filter((x) => x != null);
  if (!v.length) return null;
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  return { n: v.length, avg, min: Math.min(...v), max: Math.max(...v) };
}

export function summarize(putts) {
  const n = putts.length;
  if (!n) return null;
  let abs = 0, signed = 0, within1 = 0, onLine = 0;
  for (const p of putts) {
    abs += Math.abs(p.angleDeg);
    signed += p.angleDeg;
    if (Math.abs(p.angleDeg) <= 1) within1++;
    if (p.onLine) onLine++;
  }
  return { n, avgAbs: abs / n, bias: signed / n, within1Pct: (100 * within1) / n, onLinePct: (100 * onLine) / n };
}

// --- formatting -----------------------------------------------------------

export function fmtSpeed(mps, units = 'imperial') {
  return units === 'metric' ? `${mps.toFixed(2)} m/s` : `${(mps * 2.23694).toFixed(1)} mph`;
}

// Pelz: the best make rate comes from a ball that would finish ~17 in (43 cm) past.
export function paceVerdict(cm) {
  if (cm < 0) return 'short';
  if (cm < 20) return 'just past \u2014 a touch soft';
  if (cm <= 75) return 'good pace';
  return 'firm';
}

export function fmtAngle(deg) {
  const a = Math.abs(deg);
  if (a < 0.05) return '0.0° dead straight';
  return `${a.toFixed(1)}° ${deg < 0 ? 'left' : 'right'}`;
}

export function fmtLen(cm, units = 'imperial') {
  const a = Math.abs(cm);
  if (units === 'metric') return a >= 100 ? `${(a / 100).toFixed(2)} m` : `${a.toFixed(1)} cm`;
  const inches = a / 2.54;
  if (inches < 24) return `${inches.toFixed(1)} in`;
  const ft = Math.floor(inches / 12);
  const rest = Math.round(inches - ft * 12);
  return rest === 12 ? `${ft + 1} ft` : `${ft} ft ${rest} in`;
}
