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
        if (cancelled) return;

        // 3. Tag the user. The backend's filter relies on `store_id` and
        // `role` matching the order's storeId / 'super_admin' respectively.
        await OneSignal.User.addTag('user_id', user.id);
        await OneSignal.User.addTag('role', user.role);
        if (user.role === 'store_admin') {
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
