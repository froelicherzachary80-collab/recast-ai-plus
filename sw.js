// RECAST AI+ service worker — offline app shell + cached runtime libraries (MediaPipe WASM, Mediabunny, fonts).
// Personal media never passes through here: videos and photos are read from local files / IndexedDB only.
const VERSION = 'recast-v0.4.0';
const SHELL = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-512.png',
  'app.js', 'ui.js', 'db.js', 'geometry.js', 'tracker.js', 'smoothing.js', 'facemesh.js', 'models.js',
  'media.js', 'profile.js', 'facerender.js', 'compositor.js', 'analysis.js', 'render.js', 'caps.js', 'selftest.js', 'puppet.js', 'plate.js', 'dub.js', 'poserig.js', 'posestudio.js', 'poselib.js', 'tpose.js', 'fx.js'];
const RUNTIME_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== 'recast-runtime').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin) {
    // network-first for the app so updates land; cache fallback offline
    e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
    return;
  }
  if (RUNTIME_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open('recast-runtime').then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok || r.type === 'opaque') c.put(e.request, r.clone());
      return r;
    }));
  }
});
