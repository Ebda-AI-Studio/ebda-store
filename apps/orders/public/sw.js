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

// Bumped to v5 — purges the `force-orders-v4` shell so already-installed PWAs
// stop serving the stale app build. The previous strategy cached the `/orders`
// navigation (HTML) and only revalidated it lazily, so an installed PWA kept
// pinning an OLD build's hashed chunk references after a deploy (e.g. the order
// cards missing the guest-name fix) until sw.js itself changed. Navigations are
// now NETWORK-FIRST (see the fetch handler) so every deploy shows immediately;
// hashed static assets stay stale-while-revalidate (they're immutable).
const CACHE = 'force-orders-v5';
const APP_SHELL = ['/orders', '/manifest.webmanifest'];

// Registered synchronously on first evaluation (browsers drop/warn on listeners added later). No page messages us.
self.addEventListener('message', () => {});

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

  // Navigations (the HTML app shell) are NETWORK-FIRST so a new deploy always
  // shows on the next launch. Caching the shell (the old strategy) pinned an
  // old build's hashed chunk references in installed PWAs — they'd serve a
  // stale bundle (missing recent fixes) until sw.js changed. We still cache the
  // fresh shell as an OFFLINE fallback only.
  const isNavigation =
    request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html');
  if (isNavigation) {
    event.respondWith(
      fetch(request)
        .then(res => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then(cache => cache.put(request, copy));
          }
          return res;
        })
        .catch(() =>
          caches
            .open(CACHE)
            .then(cache => cache.match(request).then(c => c || cache.match('/orders')))
        )
    );
    return;
  }

  // Hashed static assets + other same-origin GETs: stale-while-revalidate
  // (Next.js content-hashes chunk filenames, so a cached chunk is immutable —
  // safe to serve fast, and a new build references new filenames).
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
