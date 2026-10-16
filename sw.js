// Service worker — host PWA. App shell precache + runtime caching.
const VERSION = 'clicker-host-v1.1.0';
const SHELL = [
  "./",
  "index.html",
  "display.html",
  "remote.html",
  "manifest.json",
  "css/host.css",
  "css/stage.css",
  "css/remote.css",
  "js/app.js",
  "js/db.js",
  "js/audio.js",
  "js/dashboard.js",
  "js/editor.js",
  "js/show.js",
  "js/hub.js",
  "js/stage.js",
  "js/particles.js",
  "js/typewriter.js",
  "js/remote.js",
  "js/config.js",
  "icons/icon-192.png",
  "shared/base.css",
  "shared/protocol.js",
  "shared/transport.js",
  "shared/ui.js",
  "shared/icons.js",
  "shared/qr.js"
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('clicker-host-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // never cache signaling / API traffic
  if (url.hostname.endsWith('peerjs.com')) return;

  if (url.origin === location.origin) {
    // stale-while-revalidate; query strings (?pin=1234) map onto the same shell file
    e.respondWith(caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req).then((res) => { if (res.ok) cache.put(req.url.split('?')[0], res.clone()); return res; }).catch(() => cached);
      return cached || net;
    }));
    return;
  }
  // CDN libs + Google Fonts: cache-first
  if (/unpkg\.com|jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/.test(url.hostname)) {
    e.respondWith(caches.open(VERSION).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    }));
  }
});
