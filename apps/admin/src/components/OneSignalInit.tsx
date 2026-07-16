'use client';

/**
 * OneSignal initializer for the admin PWA.
 *
 * Initialization flow:
 * 1. Wait for an authenticated admin user.
 * 2. Fetch the public OneSignal app id from the API (so we don't bake it
 *    into the build and a credential rotation doesn't require a redeploy).
 * 3. Init the SDK with `serviceWorkerPath` pointing at the static worker
 *    we ship in /apps/admin/public.
 * 4. Tag the user with role + (optional) store_id so the backend's
 *    `notifyAdminsOfOrder` filter scopes pushes correctly.
 * 5. Persist the resulting player_id to /admin/notifications/onesignal/subscribe
 *    so we have a server-side record per device.
 *
 * The SDK silently no-ops if the browser has already denied permission, so
 * a previously-blocked user won't see repeated prompts.
 */

import { useEffect, useRef } from 'react';
import OneSignal from 'react-onesignal';
import { useAuth } from '../lib/auth';
import { useStore } from '../contexts/StoreContext';
import { apiGet, apiPost } from '../lib/api';

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
 * window — it does not navigate it — so an order alert tapped while the app sat
 * on (say) the Abandoned Carts page just refocused that page instead of opening
 * the order. This listener runs in the targeted tab after that focus and
 * navigates to the notification's launch URL. App-closed clicks already open
 * the URL via the service worker; the current-URL guard avoids a redundant
 * reload in that case. Registered once, after init.
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

function describeDevice(): string {
  if (typeof navigator === 'undefined') return 'Unknown';
  const ua = navigator.userAgent;
  // Cheap, readable label — full UA is overkill for the devices list
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Browser';
}

export function OneSignalInit() {
  const { user } = useAuth();
  const { selectedStoreId } = useStore();
  const initStartedRef = useRef(false);

  useEffect(() => {
    if (!user) return;
    // Customers should never see admin push prompts.
    if (user.role === 'customer') return;
    if (initStartedRef.current) return;
    initStartedRef.current = true;

    let cancelled = false;
    (async () => {
      try {
        // 1. Get the configured app id from the API
        const { data } = await apiGet<{ appId: string; enabled: boolean }>(
          '/api/v1/admin/notifications/onesignal/config'
        );
        if (!data?.enabled || !data.appId) return;

        // 2. Init the SDK
        await OneSignal.init({
          appId: data.appId,
          // The OneSignal SDK loads its own worker from /OneSignalSDKWorker.js
          // by default. We host that file under apps/admin/public so it's
          // served from the same origin as the admin app.
          serviceWorkerPath: '/OneSignalSDKWorker.js',
          allowLocalhostAsSecureOrigin: true,
        });
        // Navigate to the notification's deep link on click (fixes the
        // already-open PWA focus-but-don't-navigate behaviour).
        registerNotificationClickNavigation();
        if (cancelled) return;

        // iOS 16.4+ / Chrome web push: granting notification permission alone
        // does NOT create a deliverable subscription. Explicitly request
        // permission + opt in so the device reaches a SUBSCRIBED state —
        // without this it registers as a player but stays
        // `notification_types=none` and every send fails with "All included
        // players are not subscribed".
        try {
          if (!OneSignal.Notifications.permission) {
            await OneSignal.Notifications.requestPermission();
          }
          if (!OneSignal.User.PushSubscription.optedIn) {
            await OneSignal.User.PushSubscription.optIn();
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[OneSignal] opt-in failed', err);
        }
        if (cancelled) return;

        // 3. Tag the user. The backend's filter relies on `store_id` and
        // `role` matching the order's storeId / 'super_admin' respectively.
        await OneSignal.User.addTag('user_id', user.id);
        await OneSignal.User.addTag('role', user.role);
        if (user.role === 'store_admin' || user.role === 'staff') {
          // selectedStoreId can be 'all' before the store list resolves, in
          // which case we don't tag yet — the next render will catch up.
          if (selectedStoreId && selectedStoreId !== 'all') {
            await OneSignal.User.addTag('store_id', selectedStoreId);
          }
        }

        // 4. Capture the subscription id and persist it server-side
        // OneSignal v16 SDK exposes the subscription id on User.PushSubscription
        const playerId = OneSignal.User?.PushSubscription?.id;
        if (playerId) {
          try {
            await apiPost('/api/v1/admin/notifications/onesignal/subscribe', {
              playerId,
              deviceLabel: describeDevice(),
            });
          } catch {
            // Best-effort — the OneSignal-side subscription is the source of
            // truth for delivery; our DB record is for the devices page only.
          }
        }
      } catch (err) {
        // Don't break the rest of the app over a push init failure
        // eslint-disable-next-line no-console
        console.warn('[OneSignal] init failed', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, selectedStoreId]);

  return null;
}
