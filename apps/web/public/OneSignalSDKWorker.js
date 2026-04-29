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
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');
