/* Force Orders — minimal service worker.
 *
 * Strategy:
 *  - Precache the app shell so the PWA opens offline.
 *  - NEVER cache API responses (authed, per-tenant, mutable). API calls are
 *    always network-first and bypass the cache entirely.
 *  - Same-origin static GETs use stale-while-revalidate.
 *  - The `push` + `notificationclick` handlers deliver real VAPID web-push
 *    new-order alerts (v2). The API (push.service.ts) sends
 *    `{ title, body, data: { tag, url, orderId } }`; the in-app NewOrderWatcher
 *    is the in-foreground complement to these background notifications.
 */

// Bumped to v2 alongside the real push-delivery handlers — the activate step
// purges the old `force-orders-v1` shell cache so the updated SW takes over.
const CACHE = 'force-orders-v2';
const APP_SHELL = ['/orders', '/manifest.webmanifest'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(cache => cache.addAll(APP_SHELL))
      .catch(() => undefined)
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never intercept cross-origin requests (the API lives on another origin).
  if (url.origin !== self.location.origin) return;

  // Stale-while-revalidate for same-origin app assets.
  event.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(request);
      const network = fetch(request)
        .then(res => {
          if (res && res.status === 200 && res.type === 'basic') {
            cache.put(request, res.clone());
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

self.addEventListener('push', event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'New order', body: event.data ? event.data.text() : '' };
  }

  // The API sends `{ title, body, data: { tag, url, orderId, ... } }`
  // (push.service.ts). Read tag/url from the nested `data` object, but fall
  // back to a flat shape for forward/backward compatibility with any other
  // sender. The `tag` is what makes a retried delivery collapse onto ONE
  // notification instead of stacking duplicates (idempotent UX).
  const meta = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  const title = payload.title || 'New order';
  const options = {
    body: payload.body || 'You have a new order.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: meta.tag || payload.tag || 'force-order',
    renotify: true,
    data: { url: meta.url || payload.url || '/orders' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/orders';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
