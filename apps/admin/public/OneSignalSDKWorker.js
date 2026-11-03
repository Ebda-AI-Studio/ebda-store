// OneSignal Web Push service worker — admin PWA.
// Hosted at /OneSignalSDKWorker.js so it's served from the same origin as the
// admin app. Required by the OneSignal Web SDK.
//
// Pre-register the four SW event handlers SYNCHRONOUSLY during initial
// evaluation to satisfy Chrome's (Chromium 133+) "Event handler of
// 'message' event must be added on the initial evaluation of worker
// script" warning. The OneSignal SDK loaded via importScripts attaches
// its own handlers additively on top — no behavior is lost.
self.addEventListener('message', () => {});
self.addEventListener('push', () => {});
self.addEventListener('notificationclick', () => {});
self.addEventListener('pushsubscriptionchange', () => {});

importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');
