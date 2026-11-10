/* Narra offline cache: serve the app shell from cache, refresh it in the background. */
const CACHE = 'narra-v1';
const SHELL = ['./', 'index.html', 'core.js', 'app.js', 'manifest.webmanifest', 'icon.svg', 'icon-maskable.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isHelper = url.hostname === 'cdnjs.cloudflare.com';
  if (!sameOrigin && !isHelper) return; // web pages being imported go straight to the network
  // the share target opens "./?text=..."; answer it with the cached app
  const key = sameOrigin && url.pathname.endsWith('/') ? './' : req;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(key, { ignoreSearch: sameOrigin });
      const fresh = fetch(req)
        .then((res) => { if (res.ok) cache.put(key, res.clone()); return res; })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
