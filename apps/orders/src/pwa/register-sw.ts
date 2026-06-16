/**
 * Registers the service worker after the page loads. Keeps registration out of
 * the render path so it never blocks first paint. No-ops on SSR / unsupported
 * browsers.
 */
export function registerServiceWorker() {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(err => {
      // Registration failures are non-fatal — the app still works online.
      console.warn('Service worker registration failed:', err);
    });
  });
}
