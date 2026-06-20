/**
 * Orders PWA — VAPID web-push subscription helper.
 *
 * Standards-based Web Push (W3C Push API / RFC 8030), the SAME stack the
 * storefront uses (apps/web PushNotificationPrompt + apps/api push.service.ts).
 * We deliberately do NOT use OneSignal here: OneSignal locks each app to a
 * single `chrome_web_origin`, and the existing admin OneSignal app is pinned to
 * app.forcemediakw.com — this PWA lives on a different origin
 * (orders.forcemediakw.com), so reusing it is impossible. VAPID is platform-wide
 * and origin-agnostic, with a subscription table + delivery service already in
 * place. Reuse, don't invent.
 *
 * The staff device registers against the `orders_app` audience via the
 * AUTHENTICATED route `/api/v1/stores/:storeId/orders-app/push/subscribe`, so
 * the order-created fanout pings only staff devices, never shoppers.
 */

import { apiPost } from './api';

export type PushSupport =
  | 'supported'
  | 'unsupported' // browser lacks SW / PushManager / Notification
  | 'no-vapid-key'; // platform misconfig — public key env missing

/** The VAPID public key, injected at build time. Falsy ⇒ push disabled. */
export function vapidPublicKey(): string | null {
  return process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || null;
}

export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (!('serviceWorker' in navigator)) return 'unsupported';
  if (!('PushManager' in window)) return 'unsupported';
  if (typeof Notification === 'undefined') return 'unsupported';
  if (!vapidPublicKey()) return 'no-vapid-key';
  return 'supported';
}

/** Web Push application-server keys are base64url; PushManager wants a Uint8Array. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Resolve the active service-worker registration, but NEVER hang.
 *
 * `navigator.serviceWorker.ready` is a promise that stays pending FOREVER when
 * no SW ever activates for the scope (registration failed, a stale install is
 * stuck, the SW file 404s). Awaiting it bare is what froze the "Enabling…"
 * button indefinitely. We:
 *   1. kick a registration in case the post-load `registerServiceWorker()` ran
 *      before the SW file was reachable (idempotent — register resolves to the
 *      existing registration if one exists);
 *   2. race `ready` against a timeout so the caller always gets an answer.
 * Returns null on timeout/failure so callers surface a real error instead of
 * spinning.
 */
async function readyRegistration(timeoutMs = 8000): Promise<ServiceWorkerRegistration | null> {
  try {
    // Best-effort (re)register; harmless if already registered.
    await navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const reg = await Promise.race([navigator.serviceWorker.ready, timeout]);
    if (timer) clearTimeout(timer);
    return reg ?? null;
  } catch {
    return null;
  }
}

/** True only when a usable push subscription is already active for this device. */
export async function isSubscribed(): Promise<boolean> {
  if (pushSupport() !== 'supported') return false;
  if (Notification.permission !== 'granted') return false;
  try {
    const reg = await readyRegistration();
    if (!reg) return false;
    const sub = await reg.pushManager.getSubscription();
    return !!sub;
  } catch {
    return false;
  }
}

/**
 * Request permission (if needed), create a VAPID push subscription, and
 * register it server-side against the `orders_app` audience for `storeId`.
 *
 * Returns the granted/denied/error outcome so the caller can drive UX. MUST be
 * called from a user gesture (button click) — Safari/iOS requires it and
 * Chrome warns otherwise.
 */
export async function subscribeToOrderPush(
  storeId: string
): Promise<'subscribed' | 'denied' | 'unsupported' | 'sw-not-ready' | 'server-rejected' | 'error'> {
  const support = pushSupport();
  if (support !== 'supported') return 'unsupported';

  try {
    const permission =
      Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') return 'denied';

    const reg = await readyRegistration();
    if (!reg) {
      // The service worker never became ready (failed/stale registration). Bail
      // with a real error instead of leaving the caller's button spinning.
      console.warn(
        '[push] service worker not ready — push subscribe aborted. ' +
          'Fully close and reopen the app to pick up the latest build.'
      );
      return 'sw-not-ready';
    }

    // Reuse an existing subscription if present, else create one.
    const existing = await reg.pushManager.getSubscription();
    const subscription =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // TS 5.7 types Uint8Array as Uint8Array<ArrayBufferLike>, which isn't
        // directly assignable to BufferSource on PushSubscriptionOptionsInit.
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey() as string) as BufferSource,
      }));

    const json = subscription.toJSON() as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };

    const { error } = await apiPost(`/api/v1/stores/${storeId}/orders-app/push/subscribe`, {
      endpoint: json.endpoint,
      keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
      deviceInfo: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 255) : undefined,
    });

    if (error) {
      console.warn('[push] server-side subscribe failed:', error);
      // Registration failed server-side — roll back the local subscription so
      // we don't end up with a device the API doesn't know about (it would
      // never receive pushes and would block re-subscribe attempts).
      await subscription.unsubscribe().catch(() => undefined);
      return 'server-rejected';
    }

    return 'subscribed';
  } catch {
    return 'error';
  }
}

/** Tear down the device subscription locally + server-side. Best-effort. */
export async function unsubscribeFromOrderPush(storeId: string): Promise<void> {
  if (pushSupport() !== 'supported') return;
  try {
    const reg = await readyRegistration();
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => undefined);
    await apiPost(`/api/v1/stores/${storeId}/orders-app/push/unsubscribe`, { endpoint }).catch(
      () => undefined
    );
  } catch {
    // best-effort
  }
}
