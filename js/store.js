// Everything stays on this phone (localStorage). Videos are never saved or uploaded.
const PUTTS = 'golflab.putts.v1';
const SETTINGS = 'golflab.settings.v1';
const SETUP = 'golflab.lastSetup.v1';

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode / full */ }
}

export const putts = {
  all: () => read(PUTTS, []),
  add(p) { const a = putts.all(); a.unshift(p); write(PUTTS, a); },
  remove(id) { write(PUTTS, putts.all().filter((p) => p.id !== id)); },
  clear() { write(PUTTS, []); },
};

export const settings = {
  get: () => ({ units: 'imperial', flip: false, slowmo: 1, hand: 'right', ...read(SETTINGS, {}) }),
  set(patch) { write(SETTINGS, { ...settings.get(), ...patch }); },
};

// Last ball + aim taps (as fractions of the frame) so a tripod session is one tap.
export const lastSetup = {
  get: () => read(SETUP, null),
  set(s) { write(SETUP, s); },
};

// Wedge clock-drill swings: { id, date, club, target: {back, thru}, back, thru (clock hours), tempo, carry (yards) }
const WEDGES = 'golflab.wedges.v1';
export const wedges = {
  all: () => read(WEDGES, []),
  add(s) { const a = wedges.all(); a.unshift(s); write(WEDGES, a.slice(0, 2000)); },
  update(id, patch) { write(WEDGES, wedges.all().map((s) => (s.id === id ? { ...s, ...patch } : s))); },
  remove(id) { write(WEDGES, wedges.all().filter((s) => s.id !== id)); },
  clear() { write(WEDGES, []); },
};
