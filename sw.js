// Service worker — host PWA. App shell precache; network-first for app files, cache-first for CDN libraries.
const VERSION = 'clicker-host-v1.5.0';
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
  "reveal.mp3",
  "show.js",
  "stage.css",
  "stage.js",
  "sync.js",
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
    // network-first: always run the newest published version when online; cached copy when offline
    e.respondWith(caches.open(VERSION).then(async (cache) => {
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res.ok) cache.put(req.url.split('?')[0], res.clone());
        return res;
      } catch (err) {
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
        throw err;
      }
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
