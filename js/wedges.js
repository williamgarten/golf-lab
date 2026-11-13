// Wedges: clock drills, filmed face-on. A live session watches every swing with the
// body tracker, reads where the lead arm stops going back and through, says it out
// loud and keeps a yardage chart. A video you already filmed works too.
import { loadPose, detectPose } from './pose.js';
import { armAngle, bodyCheck, analyzeClock, fmtClock, toHour, vsTarget, sayVs } from './clock.js';
import { makeSwing } from './fakeswing.js';
import { settings, wedges } from './store.js';
import { askMotionPermission } from './capture.js';

const $ = (id) => document.getElementById(id);
const ROLL_TOL = 2.5;          // degrees the phone may lean sideways
const ADDRESS_TOL = 15;        // arm within this many degrees of straight down
const KEEP_S = 10;             // seconds of samples kept
const THUMB_S = 4;             // seconds of thumbnails kept (to show the top and finish)
const THUMB_W = 360;

const params = new URLSearchParams(location.search);
let W = null;                  // live session state
let lastSwing = null;          // { rec, shots: { top, fin } } for the "last swing" card

// ---------------------------------------------------------------- voice

let lastSaid = '', lastSaidAt = 0;
function say(text, { force = false, gap = 3500 } = {}) {
  if (!$('wcap-voice').checked || !('speechSynthesis' in window)) return;
  const now = Date.now();
  if (!force && text === lastSaid && now - lastSaidAt < gap * 2) return;
  if (!force && now - lastSaidAt < gap) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  speechSynthesis.speak(u);
  lastSaid = text; lastSaidAt = now;
}
const spokenClock = (h) => { const [a, b] = fmtClock(h).split(':'); return b === '00' ? a : `${a} ${b}`; };

// ---------------------------------------------------------------- drill choice

const hand = () => settings.get().hand;
const flip = () => settings.get().flip;
function target() {
  const b = $('w-back').value, t = $('w-thru').value;
  return { back: b ? Number(b) : null, thru: t ? Number(t) : null };
}
const drillName = (tg) => tg.back == null && tg.thru == null ? 'no target'
  : `${tg.back != null ? fmtClock(tg.back) : '–'} to ${tg.thru != null ? fmtClock(tg.thru) : '–'}`;

// ---------------------------------------------------------------- phone tilt (sideways lean)

const grav = { roll: null, at: 0 };
function onMotion(e) {
  const g = e.accelerationIncludingGravity;
  if (!g || g.x == null || g.y == null) return;
  if (Math.hypot(g.x, g.y) < 3) { grav.roll = null; return; }   // lying flat: can't tell
  const a = (Math.atan2(g.x, g.y) * 180) / Math.PI;
  grav.roll = Math.abs(((a % 90) + 135) % 90 - 45);              // off the nearest upright / sideways position
  grav.at = Date.now();
}
const rollNow = () => (Date.now() - grav.at < 1500 ? grav.roll : null);

// ---------------------------------------------------------------- live session

export async function openWedgeSession() {
  say('Starting', { force: true });                      // speaking inside the tap unlocks voice on iPhone
  await askMotionPermission();
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    try { await DeviceMotionEvent.requestPermission(); } catch { /* level check just shows "unknown" */ }
  }
  window.addEventListener('devicemotion', onMotion);
  const fake = params.get('fakepose');

  status('Loading the body tracker… (the first time it downloads ~10 MB)');
  if (!fake) {
    try { await loadPose(); } catch {
      status('Couldn’t load the body tracker. It needs an internet connection the first time.', true);
      window.removeEventListener('devicemotion', onMotion);
      return;
    }
  }
  let stream = null;
  const cam = $('wcam');
  if (!fake) {
    try {
      stream = params.get('fakecam') ? await fakeStream(params.get('fakecam'))
        : await navigator.mediaDevices.getUserMedia({ audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } } });
    } catch {
      status('Golf Lab couldn’t open the camera. Allow camera access for this site in Safari (aA menu → Website Settings).', true);
      window.removeEventListener('devicemotion', onMotion);
      return;
    }
    cam.srcObject = stream;
    await cam.play().catch(() => {});
    await new Promise((r) => (cam.videoWidth ? r() : cam.addEventListener('loadedmetadata', r, { once: true })));
  }
  status('');
  const vw = fake ? 1920 : cam.videoWidth, vh = fake ? 1080 : cam.videoHeight;
  W = {
    stream, vw, vh, fake: fake ? fakeFeed() : null, state: 'setup', samples: [], thumbs: [], swingStart: 0, throughAt: 0,
    readyAt: 0, frames: 0, fpsAt: performance.now(), fps: 0, stop: false, lastT: -1, lastRead: null,
  };
  document.body.classList.add('capturing');
  $('wcap').hidden = false;
  cam.hidden = !!fake;
  // Size the stage to the camera's shape (fits the width, max 62% of the screen height).
  const avail = Math.min($('wcap').clientWidth - 32, (window.innerHeight * 0.62 * vw) / vh);
  $('wcap-stage').style.width = `${avail}px`;
  $('wcap-stage').style.height = `${(avail * vh) / vw}px`;
  $('wcap-read').innerHTML = '';
  setMsg(vh > vw ? 'Tip: turn the phone sideways — your swing fits better.' : 'Stand at address facing the phone.');
  loop();
}

function closeSession() {
  if (!W) return;
  W.stop = true;
  W.stream?.getTracks().forEach((t) => t.stop());
  if (fakeVid) { fakeVid.pause(); fakeVid = null; }
  window.removeEventListener('devicemotion', onMotion);
  $('wcam').srcObject = null;
  $('wcap').hidden = true;
  document.body.classList.remove('capturing');
  W = null;
  renderWedges();
}

let fakeVid = null;
async function fakeStream(src) {
  const v = document.createElement('video');
  v.src = src; v.muted = true; v.playsInline = true;
  await v.play();
  const s = v.captureStream ? v.captureStream() : v.mozCaptureStream();
  await new Promise((r) => setTimeout(r, 300));
  fakeVid = v;
  return s;
}

// ?fakepose=1 (testing on a computer): a run of made-up swings with known positions
// stands in for the camera + body tracker.
function fakeFeed() {
  const plan = [{ back: 90, thru: 90 }, { back: 100, thru: 85 }, { back: 45, thru: 50 }, { back: 135, thru: 120 }];
  let t0 = 0; const frames = [];
  plan.forEach((p, i) => {
    const sw = makeSwing({ ...p, fps: 30, lead: 2.5, hold: 2.5, seed: 11 + i, hand: hand() });
    for (const f of sw.frames) frames.push({ t: t0 + f.t, lm: f.lm });
    t0 += sw.frames.at(-1).t + 1 / 30;
  });
  const cv = document.createElement('canvas'); cv.width = 1920; cv.height = 1080;
  return { frames, start: performance.now() / 1000, canvas: cv, truth: plan };
}

function loop() {
  if (!W || W.stop) return;
  const cam = $('wcam');
  if (W.fake) {
    // Testing: step through the fake frames on their own clock, as fast as the page allows.
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { if (!W || W.stop) return; step(); if (W && W.fakeI < W.fake.frames.length) { if (W.fakeFast) ch.port2.postMessage(0); else setTimeout(() => ch.port2.postMessage(0), 33); } };
    W.fakeI = 0; W.fakeFast = params.get('fakepose') === 'fast';
    ch.port2.postMessage(0);
    return;
  }
  const next = () => {
    if (!W || W.stop) return;
    if (cam.requestVideoFrameCallback) cam.requestVideoFrameCallback(() => { step(); next(); });
    else requestAnimationFrame(() => { step(); next(); });
  };
  next();
}

function step() {
  let lm, t, src;
  if (W.fake) {
    const i = Math.min(W.fake.frames.length - 1, W.fakeI++);
    ({ lm, t } = W.fake.frames[i]);
    src = W.fake.canvas;
    drawFakeBody(src, lm);
    if (i === W.fake.frames.length - 1 && W.state !== 'swing') setMsg('Fake session finished.');
  } else {
    const cam = $('wcam');
    if (cam.currentTime === W.lastT) return;
    W.lastT = cam.currentTime;
    t = performance.now() / 1000;
    src = cam;
    try { lm = detectPose(cam); } catch { lm = null; }
  }
  W.frames++;
  const now = performance.now();
  if (now - W.fpsAt > 1000) { W.fps = (W.frames * 1000) / (now - W.fpsAt); W.frames = 0; W.fpsAt = now; $('wcap-fps').textContent = `${Math.round(W.fps)} fps`; }

  const deg = armAngle(lm, W.vw, W.vh, hand(), flip());
  W.samples.push({ t, deg, lm });
  while (W.samples.length && W.samples[0].t < t - KEEP_S) W.samples.shift();
  keepThumb(src, t);

  const body = bodyCheck(lm, W.vw, W.vh);
  const roll = rollNow();
  const phoneOk = roll == null ? null : roll <= ROLL_TOL;
  const together = handsTogether(lm);
  const steady = recentRange(0.6) < 3;
  const atAddress = deg != null && Math.abs(deg) <= ADDRESS_TOL && together && steady;

  setCheck('wchk-phone', phoneOk, roll == null ? 'Phone straight (no sensor)' : `Phone straight (${roll.toFixed(1)}°)`);
  setCheck('wchk-body', lm ? body.inFrame : false, lm ? (body.inFrame ? 'Whole body in the picture' : 'Step back — I can’t see all of you') : 'Can’t see you yet');
  setCheck('wchk-face', body.facing, 'Facing the camera');
  setCheck('wchk-addr', W.state === 'address' || W.state === 'swing' ? true : atAddress ? true : null, W.state === 'swing' ? 'Swinging…' : 'At address');
  drawOverlay(lm, deg);

  const setupOk = lm && body.inFrame && body.facing !== false && phoneOk !== false;
  switch (W.state) {
    case 'setup':
    case 'after':
      if (!lm) say('I can’t see you yet. Stand in the picture, facing the phone.');
      else if (!body.inFrame) say('Step back so I can see all of you');
      else if (body.facing === false) say('Put the phone in front of you, facing your chest');
      else if (phoneOk === false) say('Straighten the phone. It’s leaning to one side.');
      if (setupOk && atAddress) {
        W.state = 'address'; W.readyAt = t;
        say(W.lastRead ? 'Ready' : `Ready. ${drillPhrase()}`, { force: true });
        setMsg('Ready — swing when you like.');
      } else if (setupOk) setMsg('Get set at address: hands together, arm hanging straight down.');
      break;
    case 'address':
      if (!setupOk) { W.state = 'setup'; break; }
      if (deg != null && deg > 25) { W.state = 'swing'; W.swingStart = t; W.throughAt = 0; W.maxBack = deg; }
      break;
    case 'swing': {
      if (deg != null) W.maxBack = Math.max(W.maxBack, deg);
      if (deg != null && deg < -20 && !W.throughAt) W.throughAt = t;
      const settled = W.throughAt && t - W.throughAt > 0.35 && recentRange(0.3) < 5;
      if (settled || (W.throughAt && t - W.throughAt > 2.5)) finishSwing(t);
      else if (!W.throughAt && t - W.swingStart > 5) { W.state = 'setup'; setMsg('That didn’t look like a swing — reset at address.'); }
      else if (!W.throughAt && deg != null && Math.abs(deg) < 10 && W.maxBack < 40) W.state = 'address';   // just a waggle
      break;
    }
  }
}

function drillPhrase() {
  const tg = target();
  return tg.back == null && tg.thru == null ? 'Swing when you like.' : `Target, ${spokenClock(tg.back ?? 6)} to ${spokenClock(tg.thru ?? 6)}.`;
}

function finishSwing(t) {
  const from = W.swingStart - 1.5;
  const seg = W.samples.filter((s) => s.t >= from);
  const r = analyzeClock(seg.map((s) => ({ t: s.t, deg: s.deg })));
  W.state = 'after';
  if (r.error || r.back.deg < 30 || r.through.deg < 20) {
    say('Didn’t catch that one.', { force: true });
    setMsg(r.error || 'That swing was too short to read.');
    return;
  }
  const tg = target();
  const rec = {
    id: String(Date.now()), date: new Date().toISOString(), club: $('w-club').value, target: tg,
    back: r.back.hour, thru: r.through.hour, tempo: r.tempo?.ratio ?? null, carry: null,
  };
  wedges.add(rec);
  W.lastRead = rec;
  const shots = { top: shotAt(r.topT, seg), fin: shotAt(r.finishT, seg) };
  lastSwing = { rec, shots };
  showRead(rec);
  const vb = vsTarget(rec.back, tg.back), vt = vsTarget(rec.thru, tg.thru);
  say(`Back ${spokenClock(rec.back)}${vb ? `, ${sayVs(vb)}` : ''}. Through ${spokenClock(rec.thru)}${vt ? `, ${sayVs(vt)}` : ''}.`, { force: true });
  setMsg('Reset at address for the next one.');
}

function showRead(rec) {
  const tg = rec.target, vb = vsTarget(rec.back, tg.back), vt = vsTarget(rec.thru, tg.thru);
  const cls = (v) => (v ? (v.ok ? 'ok-t' : 'bad-t') : '');
  const note = (v) => (v ? (v.ok ? 'on target' : missText(v)) : '');
  $('wcap-read').innerHTML = `
    <div><span>Back</span><b class="${cls(vb)}">${fmtClock(rec.back)}</b><span>${note(vb)}</span></div>
    <div><span>Through</span><b class="${cls(vt)}">${fmtClock(rec.thru)}</b><span>${note(vt)}</span></div>
    ${rec.tempo ? `<div><span>Tempo</span><b>${rec.tempo.toFixed(1)}</b><span>: 1 (about)</span></div>` : ''}`;
}

// ---------------------------------------------------------------- helpers for the live loop

function recentRange(sec) {
  if (!W.samples.length) return Infinity;
  const tEnd = W.samples.at(-1).t;
  const v = W.samples.filter((s) => s.t >= tEnd - sec && s.deg != null).map((s) => s.deg);
  return v.length >= 3 ? Math.max(...v) - Math.min(...v) : Infinity;
}
function handsTogether(lm) {
  if (!lm) return false;
  const a = lm[15], b = lm[16], s1 = lm[11], s2 = lm[12];
  if ((a.v ?? 1) < 0.5 || (b.v ?? 1) < 0.5) return true;          // one hand hidden behind the other: fine
  const sw = Math.hypot((s1.x - s2.x) * W.vw, (s1.y - s2.y) * W.vh) || 1;
  return Math.hypot((a.x - b.x) * W.vw, (a.y - b.y) * W.vh) < 0.6 * sw;
}

function keepThumb(src, t) {
  const h = Math.round((THUMB_W * W.vh) / W.vw);
  let slot = W.thumbs.length && W.thumbs[0].t < t - THUMB_S ? W.thumbs.shift() : null;
  if (!slot) { const c = document.createElement('canvas'); c.width = THUMB_W; c.height = h; slot = { c }; }
  slot.t = t;
  slot.c.getContext('2d').drawImage(src, 0, 0, THUMB_W, h);
  W.thumbs.push(slot);
}
function shotAt(t, seg) {
  if (!W.thumbs.length) return null;
  const th = W.thumbs.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
  const s = seg.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
  const c = document.createElement('canvas');
  c.width = th.c.width; c.height = th.c.height;
  const g = c.getContext('2d');
  g.drawImage(th.c, 0, 0);
  drawBody(g, s.lm, c.width, c.height, s.deg, 0.6);
  return c;
}

function setCheck(id, ok, text) {
  const el = $(id);
  el.className = ok === true ? 'ok' : ok === false ? 'bad' : 'unknown';
  el.textContent = text;
}
const setMsg = (t) => { $('wcap-msg').textContent = t; };
function status(text, isError = false) {
  $('w-status').textContent = text;
  $('w-status').classList.toggle('error', isError);
}

// ---------------------------------------------------------------- drawing

function drawOverlay(lm, deg) {
  const cv = $('wcap-overlay'), stage = $('wcap-stage');
  const w = stage.clientWidth, h = stage.clientHeight, dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (W.fake) g.drawImage(W.fake.canvas, 0, 0, w, h);
  drawBody(g, lm, w, h, deg, 1);
}

// Stick figure + a clock face around the lead shoulder, with the target positions.
function drawBody(g, lm, w, h, deg, scale) {
  if (!lm) return;
  const P = (i) => ({ x: lm[i].x * w, y: lm[i].y * h, v: lm[i].v ?? 1 });
  const lead = P(hand() === 'left' ? 12 : 11);
  const hands = P(15), hands2 = P(16);
  const hx = (hands.x + hands2.x) / 2, hy = (hands.y + hands2.y) / 2;
  const R = Math.max(30 * scale, Math.hypot(hx - lead.x, hy - lead.y) * 1.08);
  const bs = (hand() === 'left') !== flip() ? 1 : -1;                // screen direction of "back"
  const at = (a, r = R) => ({ x: lead.x + bs * Math.sin((a * Math.PI) / 180) * r, y: lead.y + Math.cos((a * Math.PI) / 180) * r });

  // clock face
  g.lineWidth = 1.5 * scale; g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.beginPath(); g.arc(lead.x, lead.y, R, 0, Math.PI * 2); g.stroke();
  g.font = `600 ${Math.round(12 * scale + 2)}px -apple-system, system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const [hr, lab] of [[6, '6'], [7.5, '7:30'], [9, '9'], [10.5, '10:30'], [12, '12']]) {
    for (const side of [1, -1]) {
      if (hr === 6 && side < 0) continue;
      if (hr === 12 && side < 0) continue;
      const a = side * (hr - 6) * 30, p0 = at(a, R * 0.92), p1 = at(a, R * 1.04), pl = at(a, R * 1.18);
      g.strokeStyle = 'rgba(255,255,255,0.6)'; g.beginPath(); g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.75)'; g.fillText(lab, pl.x, pl.y);
    }
  }
  // targets
  const tg = target();
  g.lineWidth = 5 * scale; g.strokeStyle = 'rgba(255,216,77,0.85)';
  for (const [hr, side] of [[tg.back, 1], [tg.thru, -1]]) {
    if (hr == null) continue;
    const a = side * (hr - 6) * 30, a0 = a - 4, a1 = a + 4;
    g.beginPath();
    for (let k = 0; k <= 8; k++) { const p = at(a0 + ((a1 - a0) * k) / 8, R); k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y); }
    g.stroke();
  }
  // body
  g.lineCap = 'round'; g.lineWidth = 3 * scale; g.strokeStyle = 'rgba(77,210,255,0.85)';
  for (const [a, b] of [[11, 12], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [11, 13], [13, 15], [12, 14], [14, 16]]) {
    const p = P(a), q = P(b);
    if (p.v < 0.4 || q.v < 0.4) continue;
    g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke();
  }
  // the clock hand: lead shoulder -> hands
  if (deg != null) {
    const e = at(deg, R);
    g.lineWidth = 4 * scale; g.strokeStyle = '#fff';
    g.beginPath(); g.moveTo(lead.x, lead.y); g.lineTo(e.x, e.y); g.stroke();
    g.fillStyle = '#fff'; g.beginPath(); g.arc(e.x, e.y, 5 * scale, 0, Math.PI * 2); g.fill();
  }
}

function drawFakeBody(cv, lm) {
  const g = cv.getContext('2d');
  g.fillStyle = '#2d4d3a'; g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#3f6b50'; g.fillRect(0, cv.height * 0.85, cv.width, cv.height * 0.15);
  g.strokeStyle = '#d9c7a8'; g.lineWidth = 18; g.lineCap = 'round';
  const P = (i) => [lm[i].x * cv.width, lm[i].y * cv.height];
  for (const [a, b] of [[11, 12], [11, 23], [12, 24], [23, 27], [24, 28], [11, 15], [12, 16]]) {
    g.beginPath(); g.moveTo(...P(a)); g.lineTo(...P(b)); g.stroke();
  }
  g.beginPath(); g.arc(...P(0), 40, 0, Math.PI * 2); g.fillStyle = '#d9c7a8'; g.fill();
}

// ---------------------------------------------------------------- a video you already filmed

async function analyzeFile(file) {
  const v = $('wvideo');
  if (v.src.startsWith('blob:')) URL.revokeObjectURL(v.src);
  v.src = URL.createObjectURL(file);
  status('Loading the body tracker… (the first time it downloads ~10 MB)');
  try { await loadPose(); } catch { status('Couldn’t load the body tracker. It needs an internet connection the first time.', true); return; }
  await new Promise((r) => (v.readyState >= 1 ? r() : v.addEventListener('loadedmetadata', r, { once: true })));
  const dur = Math.min(v.duration || 0, 20);
  if (!dur) { status('Couldn’t read that video.', true); return; }
  const vw = v.videoWidth, vh = v.videoHeight, slow = settings.get().slowmo || 1;
  const samples = [];
  $('w-progress').hidden = false;
  status('Reading your swing…');
  for (let t = 0; t < dur; t += 1 / 30) {
    await seek(v, t);
    let lm = null;
    try { lm = detectPose(v); } catch { /* skip frame */ }
    samples.push({ t: v.currentTime, deg: armAngle(lm, vw, vh, hand(), flip()), lm });
    $('w-progress').firstElementChild.firstElementChild.style.width = `${(100 * t) / dur}%`;
  }
  $('w-progress').hidden = true;
  const r = analyzeClock(samples.map((s) => ({ t: s.t / slow, deg: s.deg })));
  if (r.error) { status(r.error, true); return; }
  status('');
  const tg = target();
  const rec = { id: String(Date.now()), date: new Date().toISOString(), club: $('w-club').value, target: tg,
    back: r.back.hour, thru: r.through.hour, tempo: r.tempo?.ratio ?? null, carry: null };
  wedges.add(rec);
  const still = async (tt) => {
    await seek(v, tt * slow);
    const s = samples.reduce((a, b) => (Math.abs(b.t - tt * slow) < Math.abs(a.t - tt * slow) ? b : a));
    const c = document.createElement('canvas');
    c.width = THUMB_W; c.height = Math.round((THUMB_W * vh) / vw);
    const g = c.getContext('2d');
    g.drawImage(v, 0, 0, c.width, c.height);
    drawBody(g, s.lm, c.width, c.height, s.deg, 0.6);
    return c;
  };
  lastSwing = { rec, shots: { top: await still(r.topT), fin: await still(r.finishT) } };
  renderWedges();
  $('w-last').scrollIntoView({ block: 'start', behavior: 'smooth' });
}
async function seek(v, t) {
  t = Math.max(0, Math.min(t, v.duration - 0.001));
  if (Math.abs(v.currentTime - t) < 1e-4) return;
  await new Promise((res) => { const done = () => { clearTimeout(tm); res(); }; const tm = setTimeout(done, 3000); v.addEventListener('seeked', done, { once: true }); v.currentTime = t; });
}

// ---------------------------------------------------------------- the Wedges tab

function missText(v) {
  const m = Math.round(Math.abs(v.mins) / 5) * 5, h = Math.floor(m / 60), r = m % 60;
  const amt = h ? `${h}h${r ? ` ${r}m` : ''}` : `${m} min`;
  return `${amt} ${v.mins > 0 ? 'long' : 'short'}`;
}

const unitYd = () => (settings.get().units === 'metric' ? 'm' : 'yd');
const toYd = (x) => (settings.get().units === 'metric' ? x / 0.9144 : x);
const fromYd = (y) => (settings.get().units === 'metric' ? y * 0.9144 : y);

export function renderWedges() {
  const all = wedges.all();
  // last swing
  const ls = lastSwing && all.find((s) => s.id === lastSwing.rec.id) ? lastSwing : null;
  $('w-last').hidden = !ls;
  if (ls) {
    const r = all.find((s) => s.id === ls.rec.id);
    const tg = r.target, vb = vsTarget(r.back, tg.back), vt = vsTarget(r.thru, tg.thru);
    const word = (v) => (v ? (v.ok ? '<span class="ok-t">on target</span>' : `<span class="bad-t">${missText(v)}</span>`) : '');
    $('w-last').innerHTML = `<h3>Last swing · ${r.club} · ${drillName(tg)}</h3>
      <div class="wshots"><figure id="w-shot-top"><figcaption>Top: <b>${fmtClock(r.back)}</b> ${word(vb)}</figcaption></figure>
      <figure id="w-shot-fin"><figcaption>Finish: <b>${fmtClock(r.thru)}</b> ${word(vt)}</figcaption></figure></div>
      ${r.tempo ? `<p class="small muted">Tempo about ${r.tempo.toFixed(1)} : 1 (backswing time : downswing time).</p>` : ''}`;
    if (ls.shots.top) $('w-shot-top').prepend(ls.shots.top);
    if (ls.shots.fin) $('w-shot-fin').prepend(ls.shots.fin);
  }
  $('w-chart').innerHTML = chartCard(all);
  $('w-recent').innerHTML = all.length ? `<div class="card"><h3>Recent swings</h3>
    <p class="small muted">Type how far each one carried to build your yardage chart.</p>
    <ul class="list">${all.slice(0, 30).map(rowHtml).join('')}</ul></div>` : '';
  $('w-clear').hidden = !all.length;
}

function rowHtml(s) {
  const tg = s.target, vb = vsTarget(s.back, tg.back), vt = vsTarget(s.thru, tg.thru);
  const ok = (vb?.ok ?? true) && (vt?.ok ?? true);
  const when = new Date(s.date).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `<li><span class="dot ${ok ? 'good' : 'bad'}"></span>
    <span class="grow"><b>${fmtClock(s.back)} to ${fmtClock(s.thru)}</b>
    <span class="muted small">${s.club} · target ${drillName(tg)} · ${when}</span></span>
    <input class="carry" type="number" inputmode="decimal" min="0" placeholder="${unitYd()}" data-carry="${s.id}" value="${s.carry != null ? Math.round(fromYd(s.carry)) : ''}">
    <button class="x" data-del="${s.id}" aria-label="Delete">×</button></li>`;
}

// Yardage chart: by club and drill, average carry and spread; plus how often the
// positions hit the target.
function chartCard(all) {
  if (!all.length) return '';
  const groups = new Map();
  for (const s of all) {
    const k = `${s.club}|${drillName(s.target)}`;
    if (!groups.has(k)) groups.set(k, { club: s.club, drill: drillName(s.target), swings: [] });
    groups.get(k).swings.push(s);
  }
  const rows = [...groups.values()].sort((a, b) => a.club.localeCompare(b.club) || a.drill.localeCompare(b.drill)).map((g) => {
    // Carry: only swings that hit the drill positions count, so the number is what a real "9 to 9" goes.
    const onT = (s) => (vsTarget(s.back, s.target.back)?.ok ?? true) && (vsTarget(s.thru, s.target.thru)?.ok ?? true);
    const carries = g.swings.filter(onT).map((s) => s.carry).filter((c) => c != null);
    const avg = carries.length ? carries.reduce((a, b) => a + b, 0) / carries.length : null;
    const sd = carries.length > 1 ? Math.sqrt(carries.reduce((a, c) => a + (c - avg) ** 2, 0) / (carries.length - 1)) : null;
    const hits = g.swings.filter(onT).length;
    const mean = (k) => g.swings.reduce((a, s) => a + s[k], 0) / g.swings.length;
    return `<tr><td><b>${g.club}</b><br><span class="small muted">${g.drill}</span></td>
      <td class="num">${avg != null ? `<b>${Math.round(fromYd(avg))}</b> ${unitYd()}${sd != null ? `<br><span class="small muted">±${Math.round(fromYd(sd))}</span>` : ''}` : '<span class="muted small">no on-target carries yet</span>'}</td>
      <td class="num">${fmtClock(mean('back'))} / ${fmtClock(mean('thru'))}</td>
      <td class="num">${Math.round((100 * hits) / g.swings.length)}%<br><span class="small muted">of ${g.swings.length}</span></td></tr>`;
  }).join('');
  return `<div class="card"><h3>Your yardage chart</h3>
    <table class="ychart"><tr><th>Club · drill</th><th class="num">Carry</th><th class="num">Avg back / through</th><th class="num">On target</th></tr>${rows}</table>
    <p class="small muted">“On target” = within 10 minutes of the target on both sides. Carry averages only on-target swings, so it’s what that drill really goes. The ± is how much it varies: smaller = better distance control.</p></div>`;
}

// ---------------------------------------------------------------- wiring

export function setupWedges() {
  let thruTouched = false;
  $('w-back').value = '9'; $('w-thru').value = '9';
  $('w-back').addEventListener('change', () => { if (!thruTouched) $('w-thru').value = $('w-back').value; });
  $('w-thru').addEventListener('change', () => { thruTouched = true; });
  const st = settings.get();
  if (st.wedgeClub) $('w-club').value = st.wedgeClub;
  $('w-club').addEventListener('change', (e) => settings.set({ wedgeClub: e.target.value }));
  $('w-live').addEventListener('click', openWedgeSession);
  $('wcap-done').addEventListener('click', closeSession);
  $('w-file').addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) analyzeFile(f); e.target.value = ''; });
  $('w-recent').addEventListener('change', (e) => {
    const id = e.target.dataset?.carry;
    if (!id) return;
    const v = parseFloat(e.target.value);
    wedges.update(id, { carry: v > 0 ? toYd(v) : null });
    $('w-chart').innerHTML = chartCard(wedges.all());
  });
  $('w-recent').addEventListener('click', (e) => {
    const id = e.target.dataset?.del;
    if (id) { wedges.remove(id); renderWedges(); }
  });
  $('w-clear').addEventListener('click', () => {
    if (confirm('Delete every saved wedge swing on this phone?')) { wedges.clear(); lastSwing = null; renderWedges(); }
  });
}
