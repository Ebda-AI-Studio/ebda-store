const CACHE_NAME = 'force-store-v1';
const STATIC_ASSETS = ['/', '/favicon.svg'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
      )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Only handle http/https requests (skip chrome-extension://, etc.)
  if (!url.startsWith('http')) return;

  // Network-first for API calls, cache-first for assets
  if (url.includes('/api/')) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
  } else if (event.request.method === 'GET') {
    event.respondWith(
      caches.match(event.request).then(cached => {
        const fetched = fetch(event.request)
          .then(response => {
            // Only cache successful responses
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
            }
            return response;
          })
          .catch(() => cached);
        return cached || fetched;
      })
    );
  }
});
