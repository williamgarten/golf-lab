// Makes fake body landmarks for a face-on wedge swing with known answers, for
// testing (Node test + ?fakepose=1 in the browser). Not used for real swings.
//   back / thru: lead-arm angle in degrees from straight down (90 = 9:00)
//   tback / tdown / tthru: seconds for the backswing, downswing, follow-through
export function makeSwing({ back = 90, thru = 90, tback = 0.8, tdown = 0.3, tthru = 0.45, fps = 30, hand = 'right',
  noise = 0.003, W = 1920, H = 1080, lead = 1.0, hold = 1.0, seed = 3 } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const t0 = lead, tTop = t0 + tback, tImp = tTop + tdown, tFin = tImp + tthru, end = tFin + hold;
  const angleAt = (t) => {
    if (t <= t0) return 0;
    if (t < tTop) return (back * (1 - Math.cos((Math.PI * (t - t0)) / tback))) / 2;
    if (t < tImp) return back * Math.cos((Math.PI / 2) * ((t - tTop) / tdown));
    if (t < tFin) return -thru * Math.sin((Math.PI / 2) * ((t - tImp) / tthru));
    return -thru;
  };
  const px = (x, y) => ({ x: x / W, y: y / H });
  const frames = [];
  for (let i = 0; i * (1 / fps) <= end; i++) {
    const t = i / fps, a = (angleAt(t) * Math.PI) / 180;
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, v: 0.95 }));
    const cx = W / 2, shY = H * 0.36, half = H * 0.085, armL = H * 0.25;
    const sgn = hand === 'left' ? 1 : -1;                 // right-hander: lead (left) shoulder on the picture's right
    const lead = { x: cx - sgn * half, y: shY }, trail = { x: cx + sgn * half, y: shY };
    const hands = { x: lead.x + sgn * Math.sin(a) * armL, y: lead.y + Math.cos(a) * armL };
    const n = () => gauss() * noise * H;
    const put = (idx, p, dx = 0, dy = 0) => { lm[idx] = { ...px(p.x + dx + n(), p.y + dy + n()), v: 0.95 }; };
    put(hand === 'left' ? 12 : 11, lead); put(hand === 'left' ? 11 : 12, trail);
    put(15, hands, 4, 0); put(16, hands, -4, 6);
    put(23, { x: cx - half * 0.8, y: H * 0.62 }); put(24, { x: cx + half * 0.8, y: H * 0.62 });
    put(27, { x: cx - half, y: H * 0.92 }); put(28, { x: cx + half, y: H * 0.92 });
    put(0, { x: cx, y: H * 0.25 });
    frames.push({ t, lm });
  }
  return { frames, W, H, truth: { back, thru, takeawayT: t0, topT: tTop, impactT: tImp, tempo: tback / tdown } };
}
