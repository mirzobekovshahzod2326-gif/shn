/* Sh+N service worker — offline-first app shell.
   RELEASE RULE: change VERSION on every release (it changes this file, which is what makes
   browsers install the update). Old caches are removed; IndexedDB user data is never touched here. */
const VERSION = '0.1.1';
const CACHE = 'shn-cache-' + VERSION;
const ASSETS = [
  './', 'index.html', 'styles.css', 'boot.js', 'i18n.js', 'db.js', 'app.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  // No automatic skipWaiting: the user decides when to switch to the new version.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('shn-cache-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).catch(() => (req.mode === 'navigate' ? caches.match('index.html') : Response.error()));
    })
  );
});
