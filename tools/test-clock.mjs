// Checks the wedge clock-drill maths against fake swings with known answers.
//   node tools/test-clock.mjs
import { makeSwing } from '../js/fakeswing.js';
import { armAngle, analyzeClock, fmtClock, toHour } from '../js/clock.js';

const cases = [
  { name: '9 to 9, 30 fps', back: 90, thru: 90 },
  { name: '7:30 to 7:30', back: 45, thru: 45, tback: 0.6, tdown: 0.25 },
  { name: '10:30 to 10:30, 60 fps', back: 135, thru: 135, fps: 60, tback: 0.9 },
  { name: 'full swing (past 12)', back: 200, thru: 190, tback: 1.0, tdown: 0.3 },
  { name: '9 back, 10:30 through, left-handed', back: 90, thru: 135, hand: 'left' },
  { name: 'choppy 15 fps, noisy', back: 90, thru: 80, fps: 15, noise: 0.006 },
];

let fail = 0;
const check = (label, got, want, tol) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) fail++;
  console.log(`  ${ok ? ' ' : '✗'} ${label} ${want} → ${typeof got === 'number' ? got.toFixed(2) : got}`);
};
for (const c of cases) {
  const sw = makeSwing(c);
  const samples = sw.frames.map((f) => ({ t: f.t, deg: armAngle(f.lm, sw.W, sw.H, c.hand || 'right') }));
  const r = analyzeClock(samples);
  console.log(`${c.name}: back ${fmtClock(r.back?.hour)} through ${fmtClock(r.through?.hour)} (true ${fmtClock(toHour(c.back))} / ${fmtClock(toHour(c.thru))})`);
  if (r.error) { console.log('  ✗', r.error); fail++; continue; }
  check('back deg', r.back.deg, c.back, c.noise ? 3 : 2);
  check('through deg', r.through.deg, c.thru, 2);
  check('tempo', r.tempo.ratio, sw.truth.tempo, 0.5);   // ±half a frame at the top on a 0.3 s downswing
}
// Not a swing: standing at address, a waggle.
const still = makeSwing({ back: 12, thru: 2 });
const r = analyzeClock(still.frames.map((f) => ({ t: f.t, deg: armAngle(f.lm, still.W, still.H) })));
console.log(`waggle only: ${r.error ? 'no swing ✓' : '✗ found a swing'}`); if (!r.error) fail++;
console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exit(fail ? 1 : 0);
