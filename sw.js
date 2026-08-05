/* ==========================================================================
   Tide — sw.js (Service Worker)

   ★ Important: bump the CACHE name below every time app files change.
     e.g. 'tide-v1' → 'tide-v2'
     Otherwise an old cached version can keep showing on a phone that
     already installed this app.
   ========================================================================== */

const CACHE = 'tide-v2';

/* Caches with this prefix are never deleted here — they're the mirror
   used to carry items between the Home Screen app and Safari (see
   CONFIG.mirrorPrefix in app.js). */
const KEEP_PREFIX = 'tide-mirror-';

const ASSETS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './assets/fonts/lexend-400.woff2',
  './assets/fonts/lexend-700.woff2',
  '../shared/v1/sync-global.js',
  '../shared/v1/sync.js'
];

/* Install: pre-fetch app files. shared/v1 assets are outside this SW's
   scope but can still be cached; each entry fails independently so one
   miss (e.g. first install while offline) doesn't fail the whole install. */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.all(ASSETS.map(url => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

/* Activate: remove only old versions of this app's own cache. */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE && !k.startsWith(KEEP_PREFIX))
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Cross-origin requests (GitHub API, fonts that might someday be remote,
  // etc.) are left alone — never cached, never blocked if they fail.
  if (url.origin !== self.location.origin) return;

  // The app's own mirror-transfer address is not a cacheable asset.
  if (url.pathname.indexOf('__tide-mirror') !== -1) return;

  // Navigations (including ?add=/?dump= links) always resolve to index.html.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE)
        .then(cache => cache.match('./index.html'))
        .then(hit => hit || fetch(req))
        .catch(() => fetch(req))
    );
    return;
  }

  // Everything else: cache-first, falling back to network and caching the result.
  event.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(req, { ignoreSearch: true }).then(hit => {
        if (hit) return hit;
        return fetch(req).then(res => {
          if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
          return res;
        });
      })
    ).catch(() => fetch(req))
  );
});
