/* Force Orders — minimal service worker.
 *
 * Strategy:
 *  - Precache the app shell so the PWA opens offline.
 *  - NEVER cache API responses (authed, per-tenant, mutable). API calls are
 *    always network-first and bypass the cache entirely.
 *  - Same-origin static GETs use stale-while-revalidate.
 *  - A `push` handler + `notificationclick` are wired for the v2 push-delivery
 *    path; v1 ships without a configured push provider (the in-app polling
 *    watcher handles new-order alerts), so these only fire if a future
 *    OneSignal/VAPID integration sends a payload.
 */

const CACHE = 'force-orders-v1';
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
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'New order', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'New order';
  const options = {
    body: data.body || 'You have a new order.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || 'force-order',
    data: { url: data.url || '/orders' },
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
