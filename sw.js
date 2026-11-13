// Offline support: cache the app shell so it opens on the range with no signal.
const CACHE = 'golflab-v6';
const SHELL = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'js/app.js', 'js/wedges.js', 'js/clock.js', 'js/pose.js', 'js/fakeswing.js', 'js/follow.js', 'js/stroke.js', 'js/capture.js', 'js/tracker.js', 'js/analysis.js', 'js/store.js',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

// The body tracker (MediaPipe library + model) is big and never changes for a given
// version, so it lives in its own cache, kept across app updates: cache first.
const POSE_CACHE = 'golflab-pose-0.10.14';
const POSE_HOSTS = ['cdn.jsdelivr.net', 'storage.googleapis.com'];

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== POSE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first (so updates arrive), cache as fallback when offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'GET' && POSE_HOSTS.includes(url.hostname) && /mediapipe/.test(url.pathname)) {
    e.respondWith(caches.open(POSE_CACHE).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.endsWith('.mp4')) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })   // always revalidate so updates show up
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
