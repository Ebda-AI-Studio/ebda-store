'use client';

import { useEffect, useState } from 'react';
import { useStore } from '@/contexts/StoreContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useToast } from '@/contexts/ToastContext';
import { useAuth } from '@/lib/auth';
import { can } from '@/lib/permissions';
import { isSubscribed, pushSupport, subscribeToOrderPush, vapidPublicKey } from '@/lib/push';

const DISMISSED_KEY = 'force-orders-push-dismissed';

/**
 * Post-login prompt that subscribes the staff member's device to new-order
 * push for the selected store (VAPID web-push, `orders_app` audience).
 *
 * Show rules — ALL must hold, else the banner stays hidden:
 *  - user is authenticated staff with at least order-read access (push targets
 *    people who should see orders);
 *  - a store is selected (push is per-store);
 *  - the browser supports push AND a VAPID public key is configured;
 *  - the device isn't already subscribed;
 *  - the OS permission is still `default` (never re-prompt after grant/deny —
 *    a denied user must re-enable in browser settings, surfaced as a message);
 *  - the user hasn't dismissed the banner before (localStorage);
 *  - iOS Safari: a web app can only subscribe to push when running as an
 *    INSTALLED PWA (display-mode: standalone). Before install, iOS throws on
 *    pushManager.subscribe, so we show an install hint instead of the CTA and
 *    never attempt the subscribe — and the actual subscribe always runs from
 *    the button click (a user gesture), which iOS requires.
 */
export function EnableNotifications() {
  const { user } = useAuth();
  const { selectedStoreId } = useStore();
  const { t } = useLanguage();
  const { notify } = useToast();

  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [iosNeedsInstall, setIosNeedsInstall] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function evaluate() {
      if (typeof window === 'undefined') return;
      if (!user || !selectedStoreId) return;
      // Staff-role-aware: only offer push to users who can actually read orders.
      if (!can(user, 'orders:read')) return;
      if (localStorage.getItem(DISMISSED_KEY)) return;

      const support = pushSupport();
      if (support === 'unsupported') return;
      if (support === 'no-vapid-key') return; // misconfig — silent, not the staff's problem

      // Already made a choice at the OS level? Don't nag.
      if (Notification.permission !== 'default') return;

      // Already subscribed on this device (e.g. another store session)? Hide.
      if (await isSubscribed()) return;
      if (cancelled) return;

      // iOS install gate: standalone display-mode means installed-to-home.
      const isIos =
        /iphone|ipad|ipod/i.test(navigator.userAgent) ||
        // iPadOS 13+ reports as Mac; detect touch to disambiguate.
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const isStandalone =
        window.matchMedia?.('(display-mode: standalone)').matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true;

      setIosNeedsInstall(isIos && !isStandalone);
      setVisible(true);
    }

    evaluate();
    return () => {
      cancelled = true;
    };
  }, [user, selectedStoreId]);

  if (!visible || !selectedStoreId) return null;
  if (!vapidPublicKey()) return null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // ignore
    }
    setVisible(false);
  }

  async function enable() {
    if (!selectedStoreId || busy) return;
    setBusy(true);
    try {
      const result = await subscribeToOrderPush(selectedStoreId);
      if (result === 'subscribed') {
        notify(t.notifications.enabled, 'success');
        try {
          localStorage.setItem(DISMISSED_KEY, '1');
        } catch {
          // ignore
        }
        setVisible(false);
      } else if (result === 'denied') {
        notify(t.notifications.denied, 'error');
        setVisible(false); // permission is now non-default; don't keep showing
      } else {
        notify(t.notifications.failed, 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mb-3 flex max-w-2xl items-start justify-between gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3">
      <div className="flex min-w-0 flex-col">
        <span className="text-sm font-semibold text-foreground">{t.notifications.title}</span>
        <span className="mt-0.5 text-xs text-muted-foreground">
          {iosNeedsInstall ? t.notifications.iosHint : t.notifications.body}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {!iosNeedsInstall && (
          <button
            type="button"
            onClick={enable}
            disabled={busy}
            className="inline-flex h-9 items-center rounded-full bg-primary px-4 text-xs font-semibold text-primary-foreground disabled:opacity-50"
          >
            {busy ? t.notifications.enabling : t.notifications.enable}
          </button>
        )}
        <button
          type="button"
          onClick={dismiss}
          className="inline-flex h-9 items-center rounded-full border border-border px-3 text-xs font-medium text-muted-foreground"
        >
          {t.notifications.dismiss}
        </button>
      </div>
    </div>
  );
}
