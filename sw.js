/* Offline shell for the Owner Manager. Bump the version in CACHE when you replace any file listed in SHELL. */
const PREFIX = 'grocer-manager-', CACHE = PREFIX + 'v2';
const SHELL = ['./owner_manager.html', './manager.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  /* Only this app's own older caches are removed, so the other app keeps working when both share one address. */
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => (k.startsWith(PREFIX) && k !== CACHE) || k.startsWith('grocer-pos-')).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const req = event.request;
  /* Only this app's own files are served from cache. Card devices, the Wi-Fi sync services and other apps are never touched. */
  if (req.method !== 'GET' || !req.url.startsWith(self.registration.scope)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    const refresh = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    if (cached) { event.waitUntil(refresh); return cached; }      // cache first, refresh quietly when the server is reachable
    return (await refresh) || new Response('Offline and not cached yet.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  })());
});
