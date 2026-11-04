/**
 * Merchant order alerts on THIS device: explicit opt-in only (audit G-1 follow-up, 2026-11-03).
 *
 * The OneSignal SDK used to initialise on every admin page load and show an English slidedown over the editor.
 * Now nothing loads it until `enableOrderAlerts()` runs, and that is only called from a button click. The SDK is
 * pulled in with a dynamic import here and NOWHERE else (a guard test pins it); existing subscriptions keep
 * receiving pushes because delivery is the service worker's job (public/OneSignalSDKWorker.js), not the page's.
 */
import { apiGet, apiPost } from './api';

export type EnableAlertsResult = 'enabled' | 'denied' | 'unavailable';

export interface AlertsContext {
  userId: string;
  role: string;
  /** The store being worked on; tagged only for store_admin / staff and only when it is a real id. */
  storeId?: string | null;
}

interface OneSignalClickEvent {
  notification?: {
    launchURL?: string | null;
    url?: string | null;
    additionalData?: { url?: string | null } | null;
  } | null;
  result?: { url?: string | null } | null;
}

/** Same-origin http(s) only: a hostile launch URL can never run script or leave the site. */
export function safeSameOriginUrl(raw: string | null | undefined, origin: string): string | null {
  if (!raw) return null;
  try {
    const target = new URL(raw, origin);
    if (target.protocol !== 'https:' && target.protocol !== 'http:') return null;
    if (target.origin !== origin) return null;
    return target.href;
  } catch {
    return null;
  }
}

export function describeDevice(ua: string): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Browser';
}

/** The slidedown card is the SDK's own English prompt; the merchant already said yes, so it never shows. */
function hideSdkPrompts(): void {
  if (document.getElementById('ebda-hide-onesignal-prompts')) return;
  const style = document.createElement('style');
  style.id = 'ebda-hide-onesignal-prompts';
  style.textContent =
    '#onesignal-slidedown-container,#onesignal-slidedown-dialog,.onesignal-slidedown-container{display:none!important}';
  document.head.appendChild(style);
}

type OneSignalSdk = (typeof import('react-onesignal'))['default'];

let sdkReady: Promise<OneSignalSdk | null> | null = null;

/**
 * Loads + initialises the SDK once per page and registers the push-click navigation (tapping an order alert while the
 * app is open must open that order, not just focus the window). Shared by the opt-in click and by `resumeGrantedAlerts`.
 * null = push is not configured for this deployment.
 */
function initSdk(): Promise<OneSignalSdk | null> {
  sdkReady ??= (async () => {
    const { data } = await apiGet<{ appId: string; enabled: boolean }>(
      '/api/v1/admin/notifications/onesignal/config'
    );
    if (!data?.enabled || !data.appId) return null;

    hideSdkPrompts();
    const OneSignal = (await import('react-onesignal')).default;
    await OneSignal.init({
      appId: data.appId,
      serviceWorkerPath: '/OneSignalSDKWorker.js',
      allowLocalhostAsSecureOrigin: true,
      promptOptions: { slidedown: { prompts: [] } },
    });

    try {
      (
        OneSignal.Notifications as unknown as {
          addEventListener: (event: 'click', cb: (e: OneSignalClickEvent) => void) => void;
        }
      ).addEventListener('click', event => {
        const n = event?.notification ?? undefined;
        const href = safeSameOriginUrl(
          n?.launchURL || n?.url || n?.additionalData?.url || event?.result?.url,
          window.location.origin
        );
        if (href && href !== window.location.href) window.location.assign(href);
      });
    } catch {
      // addEventListener unavailable on this SDK build; the service worker still opens the URL.
    }
    return OneSignal;
  })().catch(error => {
    sdkReady = null; // a failed load may be retried by the next call
    throw error;
  });
  return sdkReady;
}

/**
 * Page load, permission ALREADY granted (the merchant opted in before): start the SDK silently so a tapped push opens its
 * order. Never prompts, never subscribes, never runs when permission is default/denied (those still need the explicit click).
 */
export async function resumeGrantedAlerts(): Promise<void> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  try {
    await initSdk();
  } catch {
    // Best-effort: delivery is the service worker's job; only the in-app click navigation is lost.
  }
}

export async function enableOrderAlerts(ctx: AlertsContext): Promise<EnableAlertsResult> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return 'unavailable';
  // Blocked in the browser settings: do not even load the SDK.
  if (Notification.permission === 'denied') return 'denied';

  const OneSignal = await initSdk();
  if (!OneSignal) return 'unavailable';

  // Granting permission alone does not create a deliverable subscription on iOS 16.4+ / Chrome: opt in explicitly.
  if (!OneSignal.Notifications.permission) await OneSignal.Notifications.requestPermission();
  if (Notification.permission !== 'granted') return 'denied';
  if (!OneSignal.User.PushSubscription.optedIn) await OneSignal.User.PushSubscription.optIn();

  await OneSignal.User.addTag('user_id', ctx.userId);
  await OneSignal.User.addTag('role', ctx.role);
  if (
    (ctx.role === 'store_admin' || ctx.role === 'staff') &&
    ctx.storeId &&
    ctx.storeId !== 'all'
  ) {
    await OneSignal.User.addTag('store_id', ctx.storeId);
  }

  const playerId = OneSignal.User?.PushSubscription?.id;
  if (playerId) {
    try {
      await apiPost('/api/v1/admin/notifications/onesignal/subscribe', {
        playerId,
        deviceLabel: describeDevice(navigator.userAgent),
      });
    } catch {
      // Best-effort: the OneSignal-side subscription is what delivers; our row is for the devices page.
    }
  }
  return 'enabled';
}
