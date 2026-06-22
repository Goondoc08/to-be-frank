const CACHE_NAME = 'tbf-v3';
const ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const req = event.request;

  // API calls: network-first, fall back to cache when offline
  if (req.url.includes('/api/')) {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // HTML / navigations: network-first so a new app version shows up
  // immediately when online; fall back to the cached page when offline.
  const isHTML = req.mode === 'navigate' ||
                 (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    event.respondWith(
      fetch(req).then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put('./index.html', clone));
        return response;
      }).catch(() => caches.match(req).then(c => c || caches.match('./index.html')))
    );
    return;
  }

  // Other static assets: cache-first for speed, then network + cache fill
  event.respondWith(
    caches.match(req).then(cached => {
      return cached || fetch(req).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return response;
      });
    })
  );
});
