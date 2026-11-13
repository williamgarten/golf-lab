// Follows the ball through the video. Pure logic: the caller supplies frames,
// so the same code runs in the browser and in the Node test (tools/test-tracker.mjs).
import { trackBall } from './tracker.js';

const STEP = 1 / 30;       // seconds between analysed frames while the ball rolls
const REST_STEP = 0.1;     // coarser steps while waiting for the stroke

// ball: model from detectBallAt. frameAt(t): load frame at time t, return the
// actual frame time. patch(cx, cy, R): pixel block around a point of that frame.
// Returns { restT, points: [{t,x,y}], endReason } or { error }.
// frameSize: { W, H } so a ball cut off by the picture edge isn't measured (its centre would lag).
export async function followBall({ ball, tStart, duration, frameAt, patch, frameSize = null, onProgress = () => {} }) {
  const { r } = ball;
  const rest = { x: ball.x, y: ball.y };
  const moved = (d) => d && Math.hypot(d.x - rest.x, d.y - rest.y) > 0.75 * r;
  const look = (pred, R) => { const pt = patch(pred.x, pred.y, R); return pt && trackBall(pt, ball, pred, R); };

  // 1) Coarse pass: wait for the stroke. Started = the ball is seen away from its
  //    spot, or has vanished from it twice in a row (rolled out of the window).
  let t = tStart, restT = t, started = false, gone = 0;
  while (t < duration) {
    await frameAt(t);
    const d = look(rest, r * 12);
    if (moved(d) || (!d && ++gone >= 2)) { started = true; break; }
    if (d) { restT = t; gone = 0; }
    onProgress(t, null);
    t += REST_STEP;
  }
  if (!started) return { error: 'The ball never seemed to move. Check you tapped the ball before the stroke.' };

  // 2) Fine pass from the last moment the ball was still at rest.
  const points = [];
  let last = rest, vel = { x: 0, y: 0 }, lost = 0, still = 0, endReason = 'video-end';
  for (t = restT; t < duration; t += STEP) {
    const ft = await frameAt(t);
    let d;
    if (!points.length) {
      d = look(rest, r * 12);
      if (!moved(d)) {
        if (!d && t - restT > 0.5) return { error: 'Lost the ball right after the stroke. Is your shadow or the putter covering it?' };
        continue;
      }
    } else {
      const pred = { x: last.x + vel.x * (lost + 1), y: last.y + vel.y * (lost + 1) };
      const R = Math.max(r * 3, Math.hypot(vel.x, vel.y) * (1.5 + lost) + r * 2);
      d = look(pred, R);
    }
    if (d && frameSize && points.length) {
      const m = 1.5 * r;
      if (d.x < m || d.y < m || d.x > frameSize.W - m || d.y > frameSize.H - m) { endReason = 'lost'; break; }
    }
    if (d) {
      const nv = { x: d.x - last.x, y: d.y - last.y };
      if (lost) vel = { x: nv.x / (lost + 1), y: nv.y / (lost + 1) };
      else vel = points.length ? { x: 0.6 * nv.x + 0.4 * vel.x, y: 0.6 * nv.y + 0.4 * vel.y } : nv;
      still = Math.hypot(nv.x, nv.y) < 0.15 * r * (lost + 1) ? still + 1 : 0;
      last = d; lost = 0;
      points.push({ t: ft, x: d.x, y: d.y });
      if (still >= 8) { endReason = 'stopped'; break; }
    } else if (++lost > 5) { endReason = 'lost'; break; }
    onProgress(t, { restT, points, endReason });
    if (points.length > 900) break;
  }
  return { restT, points, endReason };
}
