/* ProBeing service worker — app shell only.
 *
 * Deliberately does NOT cache API traffic: the Sheet is the source of truth and
 * a cached "today" would silently show you stale logs. Offline *logging* is
 * Stage 7 and will use a localStorage queue, not this cache.
 */

var CACHE = 'probeing-shell-v1';
var SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; })
                           .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;

  // Only ever serve our own same-origin GETs from cache. Backend POSTs to
  // script.google.com must always hit the network.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // Network-first so a deploy shows up immediately; cache is the offline net.
  e.respondWith(
    fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || caches.match('index.html');
      });
    })
  );
});
