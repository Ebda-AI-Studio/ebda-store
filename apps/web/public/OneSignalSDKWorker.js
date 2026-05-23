// OneSignal Web Push v16 service worker.
// Registered by `OneSignalStorefrontInit` on the storefront via
// `serviceWorkerPath: '/OneSignalSDKWorker.js'`. The single import below
// pulls the actual SW logic from OneSignal's CDN — this is the standard
// v16 pattern documented at:
// https://documentation.onesignal.com/docs/web-push-quickstart#step-3-upload-files
//
// Hosting the file ourselves (instead of pointing the SDK at the CDN
// directly) is required because Push API service workers must live on
// the SAME ORIGIN as the page registering them.
//
// The four no-op `self.addEventListener` calls below pre-register the
// service worker event handlers SYNCHRONOUSLY during initial script
// evaluation. This satisfies Chrome's "Event handler of 'message' event
// must be added on the initial evaluation of worker script" warning
// (Chromium 133+), which fires when third-party SDKs register handlers
// inside async callbacks after their bundled code finishes loading.
// `addEventListener` is additive — OneSignal's SDK's own handlers stack
// on top of these, no behavior is lost.
self.addEventListener('message', () => {});
self.addEventListener('push', () => {});
self.addEventListener('notificationclick', () => {});
self.addEventListener('pushsubscriptionchange', () => {});

importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');
