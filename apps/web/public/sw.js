// Service worker exists for web push notifications only. Earlier versions also
// intercepted fetches to serve a "static asset cache," which kept returning
// broken responses (undefined -> "Failed to convert value to 'Response'",
// then the synthetic 503 fallback breaking /checkout navigations). The app
// relies on live API data anyway, so there's nothing to gain from caching
// pages. We now take over existing clients, purge all old caches, and leave
// network requests to the browser.

// Every worker event listener is registered synchronously here, on the first evaluation of the script (browsers warn
// about, and may drop, handlers added later from async code). `message` is a deliberate no-op: no page messages us.
self.addEventListener('message', () => {});

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(key => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

// Web Push: show notification when a push arrives
self.addEventListener('push', event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: event.data ? event.data.text() : 'Notification' };
  }

  // A merchant broadcast carries both languages in data.i18n: show the one that matches the browser, Arabic by default.
  const i18n = payload.data && payload.data.i18n;
  const lang = String((self.navigator && self.navigator.language) || 'ar')
    .toLowerCase()
    .startsWith('en')
    ? 'en'
    : 'ar';
  const localized = i18n && (i18n[lang] || i18n.ar || i18n.en);
  const title = (localized && localized.title) || payload.title || 'Notification';
  const options = {
    body: (localized && localized.body) || payload.body || '',
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

// No fetch handler — all network requests go straight to the browser.
