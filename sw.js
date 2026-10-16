// Service worker — host PWA. App shell precache + runtime caching.
const VERSION = 'clicker-host-v1.2.0';
const SHELL = [
  "./",
  "app.js",
  "audio.js",
  "base.css",
  "config.js",
  "dashboard.js",
  "db.js",
  "display.html",
  "editor.js",
  "host.css",
  "hub.js",
  "icon-192.png",
  "icons.js",
  "index.html",
  "manifest.json",
  "particles.js",
  "protocol.js",
  "qr.js",
  "remote.css",
  "remote.html",
  "remote.js",
  "show.js",
  "stage.css",
  "stage.js",
  "transport.js",
  "typewriter.js",
  "ui.js"
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
