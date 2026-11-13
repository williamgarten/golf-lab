// Live camera mode. Shows where to put the ball and which way to putt, a bubble
// level from the phone's tilt sensor, and talks you through the setup (you can't
// see the screen with the phone overhead). When the phone is level, still and the
// ball is in the circle, it records by itself and stops after the ball rolls away.
import { detectBallAt, autoFindStickers } from './tracker.js';
import { settings } from './store.js';

const $ = (id) => document.getElementById(id);
const ZONE = { x: 0.5, y: 0.72, r: 0.11 };   // "place ball here": centre (fractions) and radius (fraction of width)
const LEVEL_TOL = 1.5;                       // degrees
const READY_HOLD = 1500;                     // ms everything must stay green before recording starts
const AFTER_PUTT = 4500;                     // ms to keep recording after the ball leaves the circle
const MAX_REC = 60000;
// Putter line-up (needs the two stickers on the putter, toe + heel):
const FACE_TOL = 1.5;                        // degrees from square
const CENTRE_TOL = 2;                        // cm the head centre may sit left/right of the ball
const GAP = [2, 10];                         // cm the head centre sits behind the ball centre
const LINEUP_HOLD = 600;                     // ms the putter must stay put to count as lined up
const BALL_CM = 4.267;

const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });
const crop = document.createElement('canvas');   // full-resolution close-up around the ball, for the putter
const cctx = crop.getContext('2d', { willReadFrequently: true });
let C = null;                                // current session state
let fakeVid = null;                          // ?fakecam= testing only

// ---------------------------------------------------------------- voice

let lastSaid = '', lastSaidAt = 0;
function say(text, { force = false, gap = 3500 } = {}) {
  if (!$('cap-voice').checked || !('speechSynthesis' in window)) return;
  const now = Date.now();
  if (!force && text === lastSaid && now - lastSaidAt < gap * 2) return;
  if (!force && now - lastSaidAt < gap) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  speechSynthesis.speak(u);
  lastSaid = text; lastSaidAt = now;
}

// ---------------------------------------------------------------- tilt sensor

const tilt = { beta: null, gamma: null, at: 0, hist: [] };
function onOrient(e) {
  if (e.beta == null) return;
  const cal = settings.get().levelCal || { beta: 0, gamma: 0 };
  tilt.beta = e.beta - cal.beta;
  tilt.gamma = e.gamma - cal.gamma;
  tilt.at = Date.now();
  tilt.hist.push({ t: tilt.at, b: e.beta, g: e.gamma });
  while (tilt.hist.length && tilt.hist[0].t < tilt.at - 1000) tilt.hist.shift();
}
const sensorOk = () => Date.now() - tilt.at < 1500;

// iOS only lets a page read the tilt sensor after asking, from a tap.
export async function askMotionPermission() {
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      return (await DeviceOrientationEvent.requestPermission()) === 'granted';
    }
  } catch { return false; }
  return true;
}

// ---------------------------------------------------------------- open / close

export async function openCapture(onDone) {
  say('Starting the camera', { force: true });         // speaking inside the tap unlocks voice on iPhone
  const motionOk = await askMotionPermission();
  window.addEventListener('deviceorientation', onOrient);

  let stream;
  const fake = new URLSearchParams(location.search).get('fakecam');
  try {
    if (fake) stream = await fakeStream(fake);           // testing on a computer: a video file stands in for the camera
    else stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
    });
  } catch (err) {
    alert('Golf Lab couldn’t open the camera. Allow camera access for this site in Safari (aA menu → Website Settings), then try again.');
    window.removeEventListener('deviceorientation', onOrient);
    return;
  }
  const cam = $('cam');
  cam.srcObject = stream;
  await cam.play().catch(() => {});
  await new Promise((r) => (cam.videoWidth ? r() : cam.addEventListener('loadedmetadata', r, { once: true })));

  C = { stream, onDone, motionOk, readySince: 0, rec: null, chunks: [], recStart: 0, ballGoneSince: 0,
    ballSeen: false, ballAtStart: null, lastBall: null, timer: null, lineup: null, lineHist: [], linedUpAt: 0, addressT: null, noStickerSaid: false, fps: stream.getVideoTracks()[0]?.getSettings?.().frameRate };
  document.body.classList.add('capturing');
  $('capture').hidden = false;
  // Size the preview to the camera's exact shape (fits the width, max 70% of the screen
  // height) so the ball circle on screen matches the circle the app checks.
  const avail = Math.min($('capture').clientWidth - 32, (window.innerHeight * 0.7 * cam.videoWidth) / cam.videoHeight);
  $('cap-stage').style.width = `${avail}px`;
  $('cap-stage').style.height = `${(avail * cam.videoHeight) / cam.videoWidth}px`;
  const k = Math.min(1, 640 / Math.max(cam.videoWidth, cam.videoHeight));
  work.width = Math.round(cam.videoWidth * k);
  work.height = Math.round(cam.videoHeight * k);
  $('cap-fps').textContent = C.fps ? `${Math.round(C.fps)} fps` : '';
  const hd = settings.get().holeDistCm;
  $('cap-hole').value = hd ? (hd / (settings.get().units === 'metric' ? 100 : 30.48)).toFixed(1) : '';
  $('cap-hole-unit').textContent = settings.get().units === 'metric' ? 'm' : 'ft';
  C.timer = setInterval(tick, 200);
  tick();
}

function closeCapture() {
  if (!C) return;
  clearInterval(C.timer);
  C.stream.getTracks().forEach((t) => t.stop());
  if (fakeVid) { fakeVid.pause(); fakeVid = null; }
  window.removeEventListener('deviceorientation', onOrient);
  $('cam').srcObject = null;
  $('capture').hidden = true;
  document.body.classList.remove('capturing');
  C = null;
}

async function fakeStream(src) {
  const v = document.createElement('video');
  v.src = src; v.muted = true; v.playsInline = true; v.loop = false;
  await v.play();
  const s = v.captureStream ? v.captureStream() : v.mozCaptureStream();
  await new Promise((r) => setTimeout(r, 300));
  fakeVid = v;
  return s;
}

// ---------------------------------------------------------------- every 200 ms

function tick() {
  if (!C) return;
  const cam = $('cam');
  const W = work.width, H = work.height;
  wctx.drawImage(cam, 0, 0, W, H);

  // Ball in the circle?
  const zx = ZONE.x * W, zy = ZONE.y * H, zr = ZONE.r * W;
  const im = wctx.getImageData(Math.max(0, zx - zr * 1.4), Math.max(0, zy - zr * 1.4), Math.min(W, zr * 2.8), Math.min(H, zr * 2.8));
  const ball = detectBallAt({ width: im.width, height: im.height, data: im.data, ox: Math.max(0, zx - zr * 1.4), oy: Math.max(0, zy - zr * 1.4) }, zx, zy);
  const ballIn = !!ball && Math.hypot(ball.x - zx, ball.y - zy) <= zr;
  if (ballIn) C.lastBall = { x: ball.x / W, y: ball.y / H };

  // Level + still?
  const haveSensor = sensorOk();
  const t = haveSensor ? Math.hypot(tilt.beta, tilt.gamma) : null;
  const level = haveSensor ? t <= LEVEL_TOL : null;
  let still = null;
  if (haveSensor && tilt.hist.length > 3) {
    const bs = tilt.hist.map((h) => h.b), gs = tilt.hist.map((h) => h.g);
    still = Math.max(...bs) - Math.min(...bs) < 0.8 && Math.max(...gs) - Math.min(...gs) < 0.8;
  }

  drawOverlay(ballIn, ball && { x: ball.x / W, y: ball.y / H });
  drawLevel(haveSensor, t);
  setCheck('chk-level', level, haveSensor ? `Level (${t.toFixed(1)}°)` : 'Level sensor not available');
  setCheck('chk-ball', ballIn, ballIn ? 'Ball in the circle' : 'Put the ball in the circle');
  setCheck('chk-still', still, 'Phone held still');

  // Putter lined up behind the ball? (only while it's still at address)
  const lu = ballIn && !(C.rec && C.linedUpAt) ? checkLineup(cam, ball, W) : C.lineup;
  C.lineup = lu;
  if (lu) C.sawPutter = true;
  if (ballIn) drawLineup(lu);
  setCheck('chk-putter', C.linedUpAt ? true : lu ? lu.ok : null, C.linedUpAt ? 'Putter lined up ✓' : lu ? lu.text : 'Putter: put the toe & heel stickers on to check the line-up');

  if (C.rec) return recordingTick(ballIn);

  // Coaching (spoken, one thing at a time).
  if (haveSensor && !level) say(levelHint());
  else if (!ballIn) { C.ballSeen = false; say('Put the ball in the circle'); }
  else if (!C.ballSeen) { C.ballSeen = true; say('Ball found', { force: true }); }

  const ready = ballIn && level !== false && still !== false;
  $('cap-msg').textContent = ready ? ($('cap-auto').checked ? 'All set — hold still, recording starts in a moment.' : 'All set — tap Record.')
    : 'Get every item green. The phone will tell you what to fix.';
  if (!ready) { C.readySince = 0; return; }
  if (!C.readySince) C.readySince = Date.now();
  if ($('cap-auto').checked && Date.now() - C.readySince >= READY_HOLD) startRecording();
}

function levelHint() {
  const b = tilt.beta, g = tilt.gamma;                  // b > 0: top edge high. g > 0: right edge low.
  if (Math.abs(b) >= Math.abs(g)) return b > 0 ? 'Lower the hole end a little' : 'Raise the hole end a little';
  return g > 0 ? 'Raise the right side a little' : 'Lower the right side a little';
}

function setCheck(id, ok, text) {
  const el = $(id);
  el.className = ok === true ? 'ok' : ok === false ? 'bad' : 'unknown';
  el.textContent = text;
}

// ---------------------------------------------------------------- recording

function startRecording() {
  if (C.rec) return;
  const type = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((t) => window.MediaRecorder?.isTypeSupported?.(t));
  try {
    C.rec = new MediaRecorder(C.stream, { mimeType: type, videoBitsPerSecond: 12_000_000 });
  } catch {
    $('cap-msg').textContent = 'This browser can’t record video. Use the Camera app and upload the clip instead.';
    return;
  }
  C.chunks = [];
  C.rec.ondataavailable = (e) => e.data.size && C.chunks.push(e.data);
  C.rec.onstop = finishRecording;
  C.rec.start(500);
  C.recStart = Date.now();
  C.ballAtStart = C.lastBall;
  C.ballGoneSince = 0;
  $('cap-rec').textContent = 'Stop';
  $('capture').classList.add('recording');
  say(C.lineup ? 'Recording. Set the putter behind the ball.' : 'Recording. Putt when you’re ready.', { force: true });
}

function recordingTick(ballIn) {
  const now = Date.now();
  if (ballIn && !C.linedUpAt) {
    const lu = C.lineup;
    if (!lu) {
      if (now - C.recStart > 2500 && !C.noStickerSaid && !C.sawPutter) { C.noStickerSaid = true; say('I can’t see the putter stickers, so I won’t check the line up. Putt when you’re ready.', { force: true }); }
    } else if (lu.ok && lu.steadyMs >= LINEUP_HOLD) {
      C.linedUpAt = now;
      C.addressT = (now - C.recStart) / 1000;
      say('Lined up. Go ahead.', { force: true });
    } else if (!lu.ok && lu.steadyMs >= 400) say(lu.hint, { gap: 3000 });   // only while the putter is held still, never mid-stroke
  }
  $('cap-msg').textContent = `Recording… ${((now - C.recStart) / 1000).toFixed(0)} s`;
  if (!ballIn) { if (!C.ballGoneSince) C.ballGoneSince = now; } else C.ballGoneSince = 0;
  if ((C.ballGoneSince && now - C.ballGoneSince > AFTER_PUTT) || now - C.recStart > MAX_REC) stopRecording();
}

function stopRecording() {
  if (C?.rec && C.rec.state !== 'inactive') C.rec.stop();
}

function finishRecording() {
  const blob = new Blob(C.chunks, { type: C.rec.mimeType || 'video/mp4' });
  const meta = { ball: C.ballAtStart ? [C.ballAtStart.x, C.ballAtStart.y] : null, holeDistCm: settings.get().holeDistCm || null,
    addressT: C.addressT, address: C.linedUpAt && C.lineup ? { faceDeg: C.lineup.faceDeg, acrossCm: C.lineup.acrossCm, gapCm: C.lineup.gapCm } : null };
  const done = C.onDone;
  say('Got it. Analyzing.', { force: true });
  closeCapture();
  done(blob, meta);
}

// ---------------------------------------------------------------- putter line-up

// Looks at a full-resolution close-up behind the ball, finds the toe and heel
// stickers and checks: head centred behind the ball, right distance back, face
// square to the putt line (straight up the picture), and held still.
function checkLineup(cam, ball, W) {
  const vw = cam.videoWidth, vh = cam.videoHeight, k = vw / W;
  const bx = ball.x * k, by = ball.y * k, rN = Math.max(2, ball.r * k);
  const cmPerPxN = BALL_CM / 2 / rN;
  const half = 16 / cmPerPxN;                                  // ±16 cm across
  const sx = Math.max(0, bx - half), sy = Math.max(0, by - 8 / cmPerPxN);
  const sw = Math.min(vw - sx, 2 * half), sh = Math.min(vh - sy, 26 / cmPerPxN);   // 8 cm ahead to 18 cm behind
  if (sw < 20 || sh < 20) return null;
  const s = Math.min(1, 420 / Math.max(sw, sh));
  crop.width = Math.round(sw * s); crop.height = Math.round(sh * s);
  cctx.drawImage(cam, sx, sy, sw, sh, 0, 0, crop.width, crop.height);
  const im = cctx.getImageData(0, 0, crop.width, crop.height);
  const P = { width: im.width, height: im.height, data: im.data, ox: 0, oy: 0 };
  const b = detectBallAt(P, (bx - sx) * s, (by - sy) * s) || { x: (bx - sx) * s, y: (by - sy) * s, r: rN * s };
  const cmPerPx = BALL_CM / 2 / b.r;
  const found = autoFindStickers(P, cmPerPx);
  if (found.length < 2) return null;
  let [p, q] = found;
  if (p.x > q.x) [p, q] = [q, p];                              // p = left sticker
  const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  const acrossCm = (mid.x - b.x) * cmPerPx;                    // + = right of the ball
  const gapCm = (mid.y - b.y) * cmPerPx;                       // + = behind (down the picture)
  if (Math.abs(acrossCm) > 14 || gapCm < -4 || gapCm > 18) return null;   // not the putter
  let faceDeg = (Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI;     // + = face turned right
  if (settings.get().hand === 'left') faceDeg = -faceDeg;    // + = open for either hand

  // Steady = sticker midpoint and face angle barely moved over the last second.
  const now = Date.now();
  C.lineHist.push({ t: now, x: mid.x * cmPerPx, y: mid.y * cmPerPx, f: faceDeg });
  while (C.lineHist.length && C.lineHist[0].t < now - 1000) C.lineHist.shift();
  const H = C.lineHist, rng = (f) => Math.max(...H.map(f)) - Math.min(...H.map(f));
  const steady = H.length >= 3 && rng((h) => h.x) < 0.5 && rng((h) => h.y) < 0.5 && rng((h) => h.f) < 0.6;
  if (!steady) C.steadySince = 0; else if (!C.steadySince) C.steadySince = now;

  const centred = Math.abs(acrossCm) <= CENTRE_TOL, close = gapCm >= GAP[0] && gapCm <= GAP[1], square = Math.abs(faceDeg) <= FACE_TOL;
  const ok = centred && close && square;
  const toFix = !close ? (gapCm > GAP[1] ? 'Move the putter up to the ball' : 'Ease the putter back from the ball')
    : !square ? (faceDeg > 0 ? 'Face is open. Square it up' : 'Face is closed. Square it up')
    : !centred ? `Slide the putter a little ${acrossCm > 0 ? 'left' : 'right'}` : '';
  const face = `${Math.abs(faceDeg).toFixed(1)}° ${Math.abs(faceDeg) < 0.05 ? '' : faceDeg > 0 ? 'open' : 'closed'}`;
  return {
    ok, hint: toFix, faceDeg, acrossCm, gapCm, steadyMs: steady ? now - C.steadySince : 0,
    text: ok ? `Putter square (${face}) & centred` : !square && close ? `Putter face ${face} — square it up` : `Putter: ${toFix.toLowerCase()} (face ${face})`,
    // positions as fractions of the picture, for drawing
    pts: [p, q].map((t) => ({ x: (sx + t.x / s) / vw, y: (sy + t.y / s) / vh })),
  };
}

function drawLineup(lu) {
  if (!lu?.pts) return;
  const cv = $('cap-overlay'), g = cv.getContext('2d');
  const w = $('cap-stage').clientWidth, h = $('cap-stage').clientHeight;
  const [a, b] = lu.pts.map((p) => ({ x: p.x * w, y: p.y * h }));
  const good = lu.ok || C.linedUpAt;
  g.strokeStyle = good ? '#4ee38a' : '#ff8a4d'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
  // the face's aim: a short arrow at right angles to the toe-heel line
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = (b.y - a.y) / L, ny = -(b.x - a.x) / L;
  g.beginPath(); g.moveTo(mx, my); g.lineTo(mx + nx * L * 1.6, my + ny * L * 1.6); g.stroke();
  [a, b].forEach((p) => { g.beginPath(); g.arc(p.x, p.y, 5, 0, Math.PI * 2); g.stroke(); });
}

// ---------------------------------------------------------------- drawing

function drawOverlay(ballIn, ballPos) {
  const cv = $('cap-overlay'), stage = $('cap-stage');
  const w = stage.clientWidth, h = stage.clientHeight, dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const zx = ZONE.x * w, zy = ZONE.y * h, zr = ZONE.r * w;
  const col = ballIn ? '#4ee38a' : '#ffd84d';

  // putt direction: from the circle to the top of the picture
  g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 2; g.setLineDash([8, 6]);
  g.beginPath(); g.moveTo(zx, zy - zr - 6); g.lineTo(zx, h * 0.1); g.stroke(); g.setLineDash([]);
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.beginPath(); g.moveTo(zx, h * 0.06); g.lineTo(zx - 10, h * 0.1 + 6); g.lineTo(zx + 10, h * 0.1 + 6); g.fill();
  label(g, 'Putt this way → hole', zx, h * 0.06 - 8);

  // ball circle
  g.strokeStyle = col; g.lineWidth = 3; g.setLineDash(ballIn ? [] : [6, 5]);
  g.beginPath(); g.arc(zx, zy, zr, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
  label(g, ballIn ? 'Ball ✓' : 'Place ball here', zx, zy + zr + 18);
  if (ballPos && !ballIn) { g.strokeStyle = '#ffd84d'; g.beginPath(); g.arc(ballPos.x * w, ballPos.y * h, 8, 0, Math.PI * 2); g.stroke(); }

  // putter goes behind
  label(g, 'putter & backstroke', zx, Math.min(h - 8, zy + zr + 40), 'rgba(255,255,255,0.7)');
}

function label(g, text, x, y, color = '#fff') {
  g.font = '600 14px -apple-system, system-ui, sans-serif';
  g.textAlign = 'center';
  g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,0.6)'; g.strokeText(text, x, y);
  g.fillStyle = color; g.fillText(text, x, y);
}

function drawLevel(have, t) {
  const bub = $('bubble'), lv = $('level');
  if (!have) { lv.classList.add('off'); bub.style.transform = 'translate(-50%, -50%)'; return; }
  lv.classList.remove('off');
  const R = lv.clientWidth / 2 - 12, s = R / 8;         // full scale = 8 degrees
  let x = -tilt.gamma * s, y = -tilt.beta * s;          // the bubble floats to the HIGH side
  const m = Math.hypot(x, y); if (m > R) { x *= R / m; y *= R / m; }
  bub.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
  lv.classList.toggle('good', t <= LEVEL_TOL);
}

// ---------------------------------------------------------------- level check

// Classic two-reading check: take a reading, turn the phone 180 degrees on the
// same spot, take another. The sensor's own error is the average of the two; the
// surface's tilt is half the difference. Saves the sensor error as a correction.
let calA = null;
async function readTilt(ms = 1000) {
  const raw = [];
  const h = (e) => e.beta != null && raw.push([e.beta, e.gamma]);
  window.addEventListener('deviceorientation', h);
  await new Promise((r) => setTimeout(r, ms));
  window.removeEventListener('deviceorientation', h);
  if (raw.length < 3) return null;
  return { beta: raw.reduce((q, v) => q + v[0], 0) / raw.length, gamma: raw.reduce((q, v) => q + v[1], 0) / raw.length };
}

export function setupLevelCheck() {
  const msg = $('cal-msg');
  $('cal-1').addEventListener('click', async () => {
    if (!(await askMotionPermission())) { msg.textContent = 'Motion access was not allowed. In Safari: aA → Website Settings → Motion & Orientation.'; return; }
    msg.textContent = 'Reading… keep it still.';
    calA = await readTilt();
    if (!calA) { msg.textContent = 'No tilt sensor readings. This needs a phone.'; return; }
    msg.textContent = `Reading 1: ${fmt(calA)}. Now turn the phone around 180° on the same spot (top where the bottom was) and tap Reading 2.`;
    $('cal-2').disabled = false;
  });
  $('cal-2').addEventListener('click', async () => {
    if (!calA) return;
    msg.textContent = 'Reading… keep it still.';
    const B = await readTilt();
    if (!B) { msg.textContent = 'No readings — try again.'; return; }
    // Turning 180 degrees flips the surface's tilt but not the sensor's error.
    const bias = { beta: (calA.beta + B.beta) / 2, gamma: (calA.gamma + B.gamma) / 2 };
    const surface = Math.hypot((calA.beta - B.beta) / 2, (calA.gamma - B.gamma) / 2);
    const err = Math.hypot(bias.beta, bias.gamma);
    settings.set({ levelCal: bias });
    msg.innerHTML = `Done. Your phone’s level sensor was off by <b>${err.toFixed(1)}°</b> — now corrected. ` +
      `(The surface itself tilts ${surface.toFixed(1)}°.) ${err > 3 ? 'That’s a lot — run the check again to confirm.' : 'The level is good to use.'}`;
    calA = null;
    $('cal-2').disabled = true;
  });
  $('cal-reset').addEventListener('click', () => { settings.set({ levelCal: null }); msg.textContent = 'Correction cleared.'; });
}
const fmt = (r) => `${Math.hypot(r.beta, r.gamma).toFixed(1)}°`;

// ---------------------------------------------------------------- buttons

export function setupCaptureButtons() {
  $('cap-cancel').addEventListener('click', () => {
    if (C?.rec) { C.rec.onstop = null; C.rec.stop(); }
    closeCapture();
  });
  $('cap-rec').addEventListener('click', () => {
    if (!C) return;
    if (C.rec) stopRecording();
    else { C.ballAtStart = C.lastBall; startRecording(); }
  });
  $('cap-hole').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    settings.set({ holeDistCm: v > 0 ? v * (settings.get().units === 'metric' ? 100 : 30.48) : null });
  });
}
