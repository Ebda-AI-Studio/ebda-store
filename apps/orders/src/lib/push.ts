/**
 * Orders PWA — OneSignal push helper.
 *
 * Replaces the old VAPID web-push flow (server 403 + unreliable on iOS). We
 * MIMIC the working admin OneSignal integration (apps/admin OneSignalInit):
 * the OneSignal Web SDK owns subscription + delivery, and the backend targets
 * staff devices by a `store_id` TAG written here at enable time — no server
 * player-id storage and no server-side subscribe POST (which is the 403 path
 * the VAPID flow hit).
 *
 * OneSignal locks each app to a single `chrome_web_origin`, so the Orders PWA
 * (orders.ebda.app) uses its OWN OneSignal app, distinct from the admin
 * (store.ebda.app) and storefront (ebda.app) ones. The app
 * id comes from NEXT_PUBLIC_ONESIGNAL_ORDERS_APP_ID (Vercel env).
 *
 * SDK init runs once (idempotent) in OneSignalInit; this module owns the
 * user-gesture opt-in + tagging that EnableNotifications drives.
 */

import OneSignal from 'react-onesignal';

export type PushSupport =
  | 'supported'
  | 'unsupported' // browser lacks SW / PushManager / Notification
  | 'no-app-id'; // platform misconfig — OneSignal app id env missing

/** The Orders OneSignal app id, injected at build time. Falsy ⇒ push disabled. */
export function onesignalAppId(): string | null {
  return process.env.NEXT_PUBLIC_ONESIGNAL_ORDERS_APP_ID || null;
}

export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (!('serviceWorker' in navigator)) return 'unsupported';
  if (!('PushManager' in window)) return 'unsupported';
  if (typeof Notification === 'undefined') return 'unsupported';
  if (!onesignalAppId()) return 'no-app-id';
  return 'supported';
}

/** True only when this device already has an active OneSignal push opt-in. */
export async function isSubscribed(): Promise<boolean> {
  if (pushSupport() !== 'supported') return false;
  if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') return false;
  try {
    // OneSignal v16 SDK: User.PushSubscription.optedIn reflects the live state.
    return OneSignal.User?.PushSubscription?.optedIn === true;
  } catch {
    return false;
  }
}

/**
 * Request permission (from a user gesture) + opt the device in, then tag it
 * with `store_id` (so the backend's tag filter targets only this store's staff)
 * and `login(userId)` for an external-id link. MUST be called from a button
 * click — iOS/Safari requires the permission prompt to ride a user gesture.
 *
 * Returns the outcome so the caller can drive UX. The SDK must already be
 * init'd (OneSignalInit runs it post-auth) — if it isn't, we surface 'error'.
 */
export async function enableOrderPush(
  storeId: string,
  userId: string
): Promise<'subscribed' | 'denied' | 'unsupported' | 'error'> {
  const support = pushSupport();
  if (support !== 'supported') return 'unsupported';

  try {
    // Drive the native permission prompt from this user gesture. On a device
    // that already granted permission this resolves immediately. v16 SDK
    // resolves to the boolean grant state.
    const granted = await OneSignal.Notifications.requestPermission();
    if (
      granted !== true &&
      OneSignal.Notifications?.permission !== true &&
      !(typeof Notification !== 'undefined' && Notification.permission === 'granted')
    ) {
      return 'denied';
    }

    // Ensure the device is opted in (creates the push subscription).
    await OneSignal.User?.PushSubscription?.optIn?.();

    // Tag + external-id so the backend can target this store's staff. The
    // backend filters on `store_id`; `login` links the device to the user
    // for future per-user revocation without depending on tags. addTag is
    // synchronous (returns void) in the v16 SDK — don't await it.
    OneSignal.User.addTag('store_id', storeId);
    if (userId) {
      await OneSignal.login(userId).catch(() => undefined);
    }

    return 'subscribed';
  } catch {
    return 'error';
  }
}

/**
 * Keep the device's `store_id` tag in sync with the currently-selected store.
 *
 * The tag decides which store's order pushes this device receives. It's set at
 * enable time, but a staff member who manages multiple stores can switch the
 * active store afterwards — without this re-tag they'd stay tagged to the store
 * they enabled on and receive ITS pushes while working in another (the
 * wrong-store / "stores getting mixed" bug). Called from OneSignalInit on every
 * selectedStoreId change. No-ops unless the device is already subscribed, so it
 * never prompts; OneSignal tags are single-valued, so this overwrites (a device
 * is only ever tagged to ONE store = the one currently open).
 */
export async function syncStoreTag(storeId: string | null | undefined): Promise<void> {
  if (!storeId) return;
  if (!(await isSubscribed())) return;
  try {
    OneSignal.User.addTag('store_id', storeId);
  } catch {
    // best-effort — a failed re-tag just means the next page load retries
  }
}

/** Tear down the device opt-in + clear the store tag. Best-effort. */
export async function disableOrderPush(): Promise<void> {
  if (pushSupport() !== 'supported') return;
  try {
    await OneSignal.User?.PushSubscription?.optOut?.();
    // removeTag is synchronous (returns void) in the v16 SDK — don't await.
    OneSignal.User.removeTag('store_id');
  } catch {
    // best-effort
  }
}
