'use client';

/**
 * OneSignal initializer for the Orders PWA.
 *
 * Mirrors apps/admin/src/components/OneSignalInit.tsx but for the Orders app's
 * OWN OneSignal app (origin orders.forcemediakw.com — OneSignal locks one app
 * per origin, so it can't share the admin/storefront app).
 *
 * Init flow:
 * 1. Wait for an authenticated staff user.
 * 2. Init the SDK with the Orders app id (NEXT_PUBLIC_ONESIGNAL_ORDERS_APP_ID)
 *    + the static worker we ship at /OneSignalSDKWorker.js.
 * 3. Stop there — DO NOT prompt or tag here. The permission prompt + the
 *    `store_id` tag + `login(userId)` happen on the Enable button in
 *    EnableNotifications (a user gesture, which iOS requires). This component
 *    only readies the SDK so the gesture handler can opt the device in.
 *
 * The SDK is loaded lazily (dynamic import in providers) so the heavy
 * react-onesignal lib stays out of the login-page bundle.
 */

import { useEffect, useRef } from 'react';
import OneSignal from 'react-onesignal';
import { useAuth } from '@/lib/auth';
import { useStore } from '@/contexts/StoreContext';
import { onesignalAppId, syncStoreTag } from '@/lib/push';

/**
 * OneSignal Web SDK v16 `click` event — only the URL-bearing fields we read.
 * The event fires in the TARGETED tab after the default click action completes.
 */
interface OneSignalClickEvent {
  notification?: {
    launchURL?: string | null;
    url?: string | null;
    additionalData?: { url?: string | null } | null;
  } | null;
  result?: { url?: string | null } | null;
}

/**
 * Deep-link a tapped push to its target page, even when the PWA is ALREADY
 * OPEN. OneSignal's default web behaviour then only FOCUSES the existing
 * window without navigating it, so a tapped order push just refocused whatever
 * page was open. This listener runs in the targeted tab after that focus and
 * navigates to the notification's launch URL. App-closed clicks already open
 * the URL via the service worker; the current-URL guard avoids a redundant
 * reload then. Registered once, after init.
 */
function registerNotificationClickNavigation(): void {
  try {
    (
      OneSignal.Notifications as unknown as {
        addEventListener: (event: 'click', cb: (e: OneSignalClickEvent) => void) => void;
      }
    ).addEventListener('click', event => {
      try {
        const n = event?.notification ?? undefined;
        const raw = n?.launchURL || n?.url || n?.additionalData?.url || event?.result?.url || null;
        if (!raw) return;
        const target = new URL(raw, window.location.origin);
        // Defence-in-depth: only ever navigate to our own http(s) origin, so a
        // malformed / hostile launch URL (javascript:, data:, another host)
        // can never execute script or redirect off-site.
        if (target.protocol !== 'https:' && target.protocol !== 'http:') return;
        if (target.origin !== window.location.origin) return;
        if (target.href !== window.location.href) {
          window.location.assign(target.href);
        }
      } catch {
        // Best-effort — never let a notification click throw.
      }
    });
  } catch {
    // addEventListener unavailable on this SDK build — ignore.
  }
}

export function OneSignalInit() {
  const { user } = useAuth();
  const { selectedStoreId } = useStore();
  const initStartedRef = useRef(false);

  // Keep the device's store_id tag matching the CURRENTLY-selected store. The
  // tag is first set on the Enable button, but a multi-store staff member can
  // switch stores afterwards — re-tag here so they only ever receive the
  // currently-open store's order pushes, never a previously-enabled store's
  // (the "stores getting mixed" gap). No-ops for unsubscribed devices, so it
  // never prompts.
  useEffect(() => {
    if (!selectedStoreId) return;
    void syncStoreTag(selectedStoreId);
  }, [selectedStoreId]);

  useEffect(() => {
    if (!user) return;
    // Customers should never run the Orders app / see push prompts.
    if (user.role === 'customer') return;
    if (initStartedRef.current) return;

    const appId = onesignalAppId();
    if (!appId) return; // not configured — silently no-op

    initStartedRef.current = true;

    (async () => {
      try {
        await OneSignal.init({
          appId,
          // OneSignal loads its worker from /OneSignalSDKWorker.js by default;
          // we host that file under apps/orders/public so it's same-origin.
          serviceWorkerPath: '/OneSignalSDKWorker.js',
          allowLocalhostAsSecureOrigin: true,
        });
        // Navigate to the notification's deep link on click (fixes the
        // already-open PWA focus-but-don't-navigate behaviour).
        registerNotificationClickNavigation();
        // iOS 16.4+ / Chrome web push: granting permission alone does NOT
        // create a deliverable subscription. Explicitly request permission +
        // opt in so the device reaches a SUBSCRIBED state — otherwise it
        // registers as a player but stays `notification_types=none` and sends
        // fail with "All included players are not subscribed".
        if (!OneSignal.Notifications.permission) {
          await OneSignal.Notifications.requestPermission();
        }
        if (!OneSignal.User.PushSubscription.optedIn) {
          await OneSignal.User.PushSubscription.optIn();
        }
      } catch (err) {
        // Never break the rest of the app over a push init failure.
        console.warn('[OneSignal] init failed', err);
        initStartedRef.current = false; // allow a retry on next mount
      }
    })();
  }, [user]);

  return null;
}
