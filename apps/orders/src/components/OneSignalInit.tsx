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
