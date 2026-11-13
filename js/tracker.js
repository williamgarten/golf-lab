// Ball (and hole) finding on small image patches. No libraries.
//
// A "patch" is { width, height, data, ox, oy }: an RGBA pixel block cut out of
// the frame, where (ox, oy) is its top-left corner in frame coordinates.
// Every position returned here is in frame coordinates.

// How "golf-ball white" a pixel is: bright AND unsaturated.
// Green grass scores low (its blue channel is low and it is saturated),
// a white ball scores high even when it's a little shaded.
function whiteness(d, i) {
  const r = d[i], g = d[i + 1], b = d[i + 2];
  const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
  const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
  return mn - 0.5 * (mx - mn);
}

function luma(d, i) {
  return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
}

// Median background level and the brightest value in the patch.
function levels(patch, fn) {
  const { width: w, height: h, data: d } = patch;
  const n = w * h;
  const samples = [];
  let peak = -1e9, low = 1e9;
  for (let p = 0; p < n; p++) {
    const s = fn(d, p * 4);
    if (s > peak) peak = s;
    if (s < low) low = s;
    if ((p & 3) === 0) samples.push(s);
  }
  samples.sort((a, b) => a - b);
  return { bg: samples[samples.length >> 1], peak, low };
}

// Connected groups of pixels passing `test` (4-connected), with area + centroid.
function blobs(patch, fn, test) {
  return blobsWhere(patch, (d, i) => test(fn(d, i)));
}

// weight (optional): per-pixel weight for a sub-pixel centroid.
function blobsWhere(patch, pass, weight = null) {
  const { width: w, height: h, data: d, ox, oy } = patch;
  const n = w * h;
  const mask = new Uint8Array(n);
  for (let p = 0; p < n; p++) if (pass(d, p * 4)) mask[p] = 1;
  const out = [];
  const stack = new Int32Array(n);
  for (let p = 0; p < n; p++) {
    if (mask[p] !== 1) continue;
    let top = 0, area = 0, sx = 0, sy = 0, sw = 0;
    stack[top++] = p;
    mask[p] = 2;
    while (top) {
      const q = stack[--top];
      const x = q % w, y = (q / w) | 0;
      const wt = weight ? weight(d, q * 4) : 1;
      area++; sx += x * wt; sy += y * wt; sw += wt;
      if (x > 0 && mask[q - 1] === 1) { mask[q - 1] = 2; stack[top++] = q - 1; }
      if (x < w - 1 && mask[q + 1] === 1) { mask[q + 1] = 2; stack[top++] = q + 1; }
      if (y > 0 && mask[q - w] === 1) { mask[q - w] = 2; stack[top++] = q - w; }
      if (y < h - 1 && mask[q + w] === 1) { mask[q + w] = 2; stack[top++] = q + w; }
    }
    out.push({ area, cx: ox + sx / sw + 0.5, cy: oy + sy / sw + 0.5 });
  }
  return out;
}

// The user tapped near (x, y). Find the white ball closest to the tap.
// Returns a "model" of the ball used for tracking, or null.
export function detectBallAt(patch, x, y) {
  const { bg, peak } = levels(patch, whiteness);
  if (peak - bg < 45) return null; // nothing white here
  const thr = bg + 0.5 * (peak - bg);
  const list = blobs(patch, whiteness, (s) => s > thr).filter((b) => b.area >= 5);
  let best = null, bestCost = 1e9;
  for (const b of list) {
    const cost = Math.hypot(b.cx - x, b.cy - y) - Math.sqrt(b.area);
    if (cost < bestCost) { bestCost = cost; best = b; }
  }
  if (!best) return null;
  const r0 = Math.sqrt(best.area / Math.PI);
  if (Math.hypot(best.cx - x, best.cy - y) > Math.max(30, 5 * r0)) return null;
  // The size sets the real-world scale, so measure it from brightness only:
  // phone video stores colour at half resolution, which shrinks a colour-based edge.
  const r = lumaRadius(patch, best.cx, best.cy, r0) || r0;
  return { x: best.cx, y: best.cy, r, area: best.area, contrast: peak - bg };
}

// Ball radius from brightness: pixels brighter than halfway between the ball's
// counted within 2x the rough radius.
function lumaRadius(patch, cx, cy, r0) {
  const { width: w, height: h, data: d, ox, oy } = patch;
  let peak = -1, ring = [], n = 0;
  const box = Math.ceil(r0 * 3);
  const px = [];
  for (let y = Math.max(0, Math.floor(cy - oy - box)); y < Math.min(h, cy - oy + box); y++)
    for (let x = Math.max(0, Math.floor(cx - ox - box)); x < Math.min(w, cx - ox + box); x++) {
      const dist = Math.hypot(x + 0.5 - (cx - ox), y + 0.5 - (cy - oy));
      const l = luma(d, (y * w + x) * 4);
      if (dist <= r0 * 0.5 && l > peak) peak = l;
      if (dist >= r0 * 2 && dist <= r0 * 3) ring.push(l);
      if (dist <= r0 * 2) px.push(l);
    }
  if (peak < 0 || ring.length < 8) return null;
  ring.sort((a, b) => a - b);
  // A third of the way up from the grass, not halfway: a real ball is darker
  // toward its edge (it curves away from the light), so halfway cuts it short.
  const grass = ring[ring.length >> 1];
  const thr = grass + 0.33 * (peak - grass);
  for (const l of px) if (l > thr) n++;
  return n ? Math.sqrt(n / Math.PI) : null;
}

// Find the ball near a predicted position in a new frame.
// Re-measures the threshold every frame so shadows / lighting changes are OK.
export function trackBall(patch, model, pred, searchR) {
  const { bg, peak } = levels(patch, whiteness);
  if (peak - bg < Math.max(25, 0.35 * model.contrast)) return null;
  const thr = bg + 0.5 * (peak - bg);
  let best = null, bestCost = 1e9;
  for (const b of blobs(patch, whiteness, (s) => s > thr)) {
    const ratio = b.area / model.area;
    if (ratio < 0.3 || ratio > 4) continue;
    const dist = Math.hypot(b.cx - pred.x, b.cy - pred.y);
    if (dist > searchR) continue;
    const cost = dist / searchR + 0.5 * Math.abs(Math.log(ratio));
    if (cost < bestCost) { bestCost = cost; best = b; }
  }
  return best && { x: best.cx, y: best.cy, area: best.area };
}

// Snap a tap to the hole: a dark round patch a few times bigger than the ball.
// Returns {x, y} or null (then the raw tap is used as the aim point).
export function detectHoleAt(patch, x, y, ballArea) {
  const { bg, low } = levels(patch, luma);
  if (bg - low < 35) return null;
  const thr = bg - 0.5 * (bg - low);
  let best = null, bestDist = 1e9;
  for (const b of blobs(patch, luma, (s) => s < thr)) {
    const ratio = b.area / ballArea;
    if (ratio < 2.5 || ratio > 14) continue;
    const dist = Math.hypot(b.cx - x, b.cy - y);
    if (dist < bestDist) { bestDist = dist; best = b; }
  }
  if (!best) return null;
  const holeR = Math.sqrt(best.area / Math.PI);
  return bestDist <= holeR * 2.5 ? { x: best.cx, y: best.cy } : null;
}

// ---------------------------------------------------------------- putter stickers
// Bright dot stickers (neon pink / orange / blue) on top of the putter head.
// Found by colour: vivid pixels whose hue matches the tapped sticker. Grass hues
// (yellow-green to teal) are never treated as a sticker.

function hsv(d, i) {
  const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
  let h = 0;
  if (c > 0) {
    if (mx === r) h = ((g - b) / c) % 6; else if (mx === g) h = (b - r) / c + 2; else h = (r - g) / c + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, mx ? c / mx : 0, mx];
}
const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const grassHue = (h) => h >= 65 && h <= 170;
const HUE_TOL = 24;

function matches(d, i, hue) {
  const [h, s, v] = hsv(d, i);
  return s > 0.35 && v > 0.28 && hueDist(h, hue) <= HUE_TOL;
}

// All sticker-coloured blobs in a patch: [{ x, y, area }].
export function stickerBlobs(patch, hue) {
  // Edge pixels are part grass / part putter, so they count less toward the centre.
  const weight = (d, i) => { const [, s, v] = hsv(d, i); return s * v; };
  return blobsWhere(patch, (d, i) => matches(d, i, hue), weight)
    .filter((b) => b.area >= 3)
    .map((b) => ({ x: b.cx, y: b.cy, area: b.area }));
}

// The user tapped near (x, y): find the sticker there. Returns { x, y, area, r, hue } or null.
export function detectStickerAt(patch, x, y) {
  const { width: w, height: h, data: d, ox, oy } = patch;
  let best = null, bestScore = -1e9;
  for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
    const [hh, s, v] = hsv(d, (py * w + px) * 4);
    if (s < 0.4 || v < 0.3 || grassHue(hh)) continue;
    const score = s * v - Math.hypot(px + ox - x, py + oy - y) / w;
    if (score > bestScore) { bestScore = score; best = hh; }
  }
  if (best == null) return null;
  let pick = null, pickD = 1e9;
  for (const b of stickerBlobs(patch, best)) {
    const dist = Math.hypot(b.x - x, b.y - y);
    if (dist < pickD) { pickD = dist; pick = b; }
  }
  if (!pick || pickD > Math.max(25, 4 * Math.sqrt(pick.area))) return null;
  return { ...pick, r: Math.sqrt(pick.area / Math.PI), hue: best };
}

// Same-setup putts: find up to `n` stickers of a known colour/size near a point.
export function findStickers(patch, model, near, n) {
  return stickerBlobs(patch, model.hue)
    .filter((b) => b.area / model.area > 0.35 && b.area / model.area < 2.8)
    .sort((a, b) => Math.hypot(a.x - near.x, a.y - near.y) - Math.hypot(b.x - near.x, b.y - near.y))
    .slice(0, n)
    .map((b) => ({ ...b, r: Math.sqrt(b.area / Math.PI), hue: model.hue }));
}

// No taps: find a pair of bright, same-coloured stickers near the ball (live mode).
// Looks for the most common vivid non-grass colour, then blobs of sticker size
// (about 3/4 in across) that sit 1.5-6 in apart. Returns 0, 1 or 2 stickers.
export function autoFindStickers(patch, cmPerPx) {
  const { width: w, height: h, data: d } = patch;
  const bins = new Array(24).fill(0);
  for (let p = 0; p < w * h; p += 2) {
    const [hh, s, v] = hsv(d, p * 4);
    if (s >= 0.45 && v >= 0.35 && !grassHue(hh)) bins[Math.floor(hh / 15) % 24]++;
  }
  const best = bins.indexOf(Math.max(...bins));
  if (bins[best] < 6) return [];
  const hue = best * 15 + 7.5;
  const minA = 0.8 / cmPerPx ** 2, maxA = 9 / cmPerPx ** 2;           // cm^2 -> px^2
  const blobs = stickerBlobs(patch, hue).filter((b) => b.area >= Math.max(4, minA) && b.area <= maxA)
    .sort((a, b) => b.area - a.area).slice(0, 6);
  let pair = null, bestScore = Infinity;
  for (let i = 0; i < blobs.length; i++) for (let j = i + 1; j < blobs.length; j++) {
    const sep = Math.hypot(blobs[i].x - blobs[j].x, blobs[i].y - blobs[j].y) * cmPerPx;
    if (sep < 4 || sep > 15) continue;
    const score = Math.abs(Math.log(blobs[i].area / blobs[j].area));   // similar size
    if (score < bestScore) { bestScore = score; pair = [blobs[i], blobs[j]]; }
  }
  const out = pair || blobs.slice(0, 1);
  return out.map((b) => ({ ...b, r: Math.sqrt(b.area / Math.PI), hue }));
}
