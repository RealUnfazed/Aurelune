// Aurelune service worker. Its only job is to let the app OPEN without a connection (so offline downloads can be played):
// it keeps a copy of the app shell (page, scripts, styles, fonts, icons) and of the pictures you have seen.
// It never touches the API or audio: those always go to the network, and downloads live in the app's own encrypted storage.
const VERSION = 'aur-shell-v5';
const IMAGES = 'aur-images-v1';
const SHELL = ['/', '/css/styles.css', '/css/fonts.css', '/js/app.js', '/icon.svg', '/icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== IMAGES).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function trim(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

/** Network first, but a dead or crawling connection falls back to the cached copy after a few seconds instead of hanging the app. */
async function netFirst(req, cacheKey) {
  const cached = await caches.match(cacheKey || req);
  const net = fetch(req).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(cacheKey || req, copy)).catch(() => {}); } // clone NOW: once the page starts reading r, it can't be cloned
    return r;
  });
  if (!cached) return net;
  return Promise.race([net, new Promise((res) => setTimeout(() => res(cached), 4000))]).catch(() => cached);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;

  // Pictures (covers, artwork), from any host: show what was cached when offline, refresh in the background.
  if (req.destination === 'image') {
    e.respondWith((async () => {
      const cache = await caches.open(IMAGES);
      const hit = await cache.match(req);
      const net = fetch(req).then((r) => { if (r && (r.ok || r.type === 'opaque')) { cache.put(req, r.clone()).then(() => trim(cache, 400)).catch(() => {}); } return r; }).catch(() => null);
      return hit || (await net) || Response.error();
    })());
    return;
  }
  if (!same || url.pathname.startsWith('/api/') || url.pathname.startsWith('/embed/')) return;

  // The page itself: network first, so a new version is picked up at once; the cached copy only when there is no connection.
  if (req.mode === 'navigate') {
    e.respondWith(netFirst(req, '/').catch(() => Response.error()));
    return;
  }
  // Scripts, styles, fonts, icons: network first, cache as the fallback (keeps every file consistent with its version).
  e.respondWith(netFirst(req).catch(() => Response.error()));
});
