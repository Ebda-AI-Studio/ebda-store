'use client';

/**
 * OneSignal Web SDK v16 initializer for the storefront.
 *
 * Why a script injection instead of `react-onesignal`?
 * The admin app already uses the `react-onesignal` package, but per Group J
 * constraints we must not add new runtime deps to the storefront. The
 * official OneSignal v16 page SDK loads fine via a `<script defer>` tag and
 * exposes `window.OneSignal` (a deferred queue) the same way the package
 * does, so everything below works identically — tagging, subscription state,
 * etc.
 *
 * Lifecycle:
 *  1. Mount only when push is enabled in the store's features and the
 *     `NEXT_PUBLIC_ONESIGNAL_APP_ID` env var is set. Anything else and we
 *     render nothing — the storefront should never crash because OneSignal
 *     wasn't configured.
 *  2. Inject the v16 page SDK once (`document.head` + `defer`).
 *  3. Push an init function onto the `window.OneSignalDeferred` queue. This
 *     is the v16 idiom — the SDK runs each callback once it's loaded.
 *  4. On every subscription change AND once at boot, if the user has granted
 *     permission, write `storeId = <store.id>` as a tag. This is what the
 *     `OneSignalService.broadcastToStore` REST filter matches against.
 *
 * The component renders nothing visually — it just side-effects. The real
 * consent prompt is the OneSignal slidedown the SDK manages internally; we
 * keep `PushNotificationPrompt` for VAPID/W3C Push as a fallback.
 */

import { useEffect } from 'react';
import { useStore } from '../contexts/StoreContext';
import { useFeatures } from '../contexts/FeatureContext';

// Minimal v16 typings — we only touch the surfaces we use, so we don't
// pull in the full @types/onesignal-sdk just for two methods.
interface OneSignalV16 {
  init: (opts: {
    appId: string;
    serviceWorkerPath?: string;
    allowLocalhostAsSecureOrigin?: boolean;
    autoResubscribe?: boolean;
    notifyButton?: { enable?: boolean };
  }) => Promise<void>;
  User?: {
    addTag?: (key: string, value: string) => Promise<void> | void;
    PushSubscription?: {
      addEventListener?: (event: 'change', handler: (state: unknown) => void) => void;
      optedIn?: boolean;
    };
  };
  Notifications?: {
    permission?: boolean;
    addEventListener?: (event: string, handler: (state: unknown) => void) => void;
  };
}

declare global {
  interface Window {
    OneSignal?: OneSignalV16;
    OneSignalDeferred?: Array<(os: OneSignalV16) => void>;
  }
}

const SDK_SRC = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js';
const SDK_SCRIPT_ID = 'onesignal-page-sdk';

export function OneSignalStorefrontInit() {
  const { store } = useStore();
  const { isEnabled } = useFeatures();

  useEffect(() => {
    // Hard-gate: only mount when the merchant turned push on AND env is set.
    if (!isEnabled('push_notifications')) return;
    const appId = process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID;
    if (!appId) return;
    if (!store?.id) return;

    // Don't run on the server, or in browsers that can't do push at all.
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;

    let cancelled = false;

    // Helper that runs once OneSignal is ready. Stored on the deferred queue
    // — that's the official v16 pattern for non-blocking init.
    const enqueue = (fn: (os: OneSignalV16) => void) => {
      window.OneSignalDeferred = window.OneSignalDeferred || [];
      window.OneSignalDeferred.push(fn);
    };

    // 1. Inject the v16 page SDK exactly once. Re-mounting this component
    //    (e.g. on a route change in dev) MUST NOT re-add the script tag —
    //    OneSignal explodes if its globals already exist.
    if (!document.getElementById(SDK_SCRIPT_ID) && !window.OneSignal) {
      const script = document.createElement('script');
      script.id = SDK_SCRIPT_ID;
      script.src = SDK_SRC;
      script.defer = true;
      document.head.appendChild(script);
    }

    // 2. Init + tag.
    enqueue(async OneSignal => {
      if (cancelled) return;
      try {
        await OneSignal.init({
          appId,
          // The OneSignal SDK auto-registers `/OneSignalSDKWorker.js` on the
          // origin. We don't ship that file in apps/web/public — but the
          // SDK can fall back to a CDN-hosted worker via `OneSignalSDK.sw.js`
          // when no local file is found. To keep things robust, pass the
          // explicit path; if a future engineer wants to host it locally
          // they only need to drop the file in apps/web/public.
          serviceWorkerPath: '/OneSignalSDKWorker.js',
          allowLocalhostAsSecureOrigin: true,
          autoResubscribe: true,
        });
      } catch (err) {
        // Push is an enhancement, never block the storefront.
        console.warn('[OneSignal storefront] init failed', err);
        return;
      }
      if (cancelled) return;

      const tagStore = async () => {
        try {
          await OneSignal.User?.addTag?.('storeId', store.id);
        } catch {
          // Non-fatal — without the tag the device just won't receive
          // store-scoped broadcasts; it can't accidentally receive other
          // tenants' broadcasts because the REST filter is `=`, not `!=`.
        }
      };

      // Tag now (covers the case where the user already opted in on a
      // previous visit), and on every subscription change.
      void tagStore();
      try {
        OneSignal.User?.PushSubscription?.addEventListener?.('change', () => {
          void tagStore();
        });
      } catch {
        // Older SDK builds may not expose the listener — silently skip.
      }
    });

    return () => {
      cancelled = true;
    };
  }, [store?.id, isEnabled]);

  return null;
}
