const CACHE_NAME = 'force-store-v3';
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

// Web Push: show notification when a push arrives
self.addEventListener('push', event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: event.data ? event.data.text() : 'Notification' };
  }

  const title = payload.title || 'Notification';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icon-192.png',
    badge: payload.badge || '/icon-192.png',
    data: payload.data || {},
    tag: payload.tag,
    requireInteraction: payload.requireInteraction || false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Focus existing tab or open a new one when notification is clicked
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(url).catch(() => {});
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
    })
  );
});

self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Only handle http/https requests (skip chrome-extension://, etc.)
  if (!url.startsWith('http')) return;

  // Network-first for API calls and Next.js chunks, cache-first for other assets
  if (url.includes('/api/') || url.includes('/_next/')) {
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
