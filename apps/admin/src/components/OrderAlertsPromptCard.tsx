'use client';

import { useEffect, useState } from 'react';
import type { SetupGuideState } from '@ebda/shared';
import { apiGet } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useStore } from '../contexts/StoreContext';
import { enableOrderAlerts } from '../lib/push-opt-in';
import { OrderAlertsModal } from './OrderAlertsModal';

/** "Not now" hides the card for 14 days, per user, per device (localStorage). */
export const ORDER_ALERTS_DISMISS_DAYS = 14;
export const orderAlertsDismissKey = (userId: string) => `ebda.orderAlerts.dismissedAt.${userId}`;

function dismissedRecently(userId: string): boolean {
  try {
    const raw = window.localStorage.getItem(orderAlertsDismissKey(userId));
    const at = raw ? Number(raw) : NaN;
    return Number.isFinite(at) && Date.now() - at < ORDER_ALERTS_DISMISS_DAYS * 86_400_000;
  } catch {
    return false;
  }
}

export const SESSION_START_KEY = 'ebda.orderAlerts.sessionStart';
export const SESSION_VIEWS_KEY = 'ebda.orderAlerts.sessionViews';
/** Never on the first page view of a session: wait this long, or one navigation, whichever comes first. */
export const SESSION_GRACE_MS = 10_000;

/** Registers this page view; returns ms still to wait before the modal may show (0 = now). */
function graceRemainingMs(): number {
  try {
    const now = Date.now();
    const started = Number(window.sessionStorage.getItem(SESSION_START_KEY)) || now;
    window.sessionStorage.setItem(SESSION_START_KEY, String(started));
    const views = (Number(window.sessionStorage.getItem(SESSION_VIEWS_KEY)) || 0) + 1;
    window.sessionStorage.setItem(SESSION_VIEWS_KEY, String(views));
    if (views >= 2) return 0;
    return Math.max(0, SESSION_GRACE_MS - (now - started));
  } catch {
    return SESSION_GRACE_MS;
  }
}

const anotherDialogOpen = () =>
  !!document.querySelector('[role="dialog"],[role="alertdialog"],[aria-modal="true"]');

/**
 * Order-alerts ask: a centred, Ebda-styled modal dialog. Shown only when the browser supports push, permission is
 * still 'default', the merchant has >= 1 order or finished the required setup steps, it was not dismissed in the last
 * 14 days, no other dialog is open, and it is not the first page view of the session. Esc / "later" = dismiss.
 * The push SDK is NOT loaded here: only the primary button calls enableOrderAlerts.
 */
export function OrderAlertsPromptCard({ storeId }: { storeId: string }) {
  const { user } = useAuth();
  const { selectedStoreId } = useStore();
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const userId = user?.id;
  const isStaffRole = !!user && user.role !== 'customer';

  useEffect(() => {
    if (!userId || !isStaffRole) return;
    if (typeof window === 'undefined' || typeof Notification === 'undefined') return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (Notification.permission !== 'default') return;
    if (dismissedRecently(userId)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    (async () => {
      const [stats, guide] = await Promise.all([
        apiGet<{ orderCount: number }>(`/api/v1/stores/${storeId}/stats`),
        apiGet<SetupGuideState>(`/api/v1/stores/${storeId}/setup-guide`),
      ]);
      if (cancelled) return;
      const hasOrder = (stats.data?.orderCount ?? 0) >= 1;
      const guideDone =
        !!guide.data &&
        guide.data.requiredTotal > 0 &&
        guide.data.requiredDone === guide.data.requiredTotal;
      if (!(hasOrder || guideDone)) return;
      timer = setTimeout(function reveal() {
        if (cancelled) return;
        // Never on top of another dialog: look again shortly.
        if (anotherDialogOpen()) timer = setTimeout(reveal, 3000);
        else {
          setVisible(true);
        }
      }, graceRemainingMs());
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [userId, isStaffRole, storeId]);

  if (!visible || !user) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(orderAlertsDismissKey(user!.id), String(Date.now()));
    } catch {
      // storage blocked: the card simply hides for this visit
    }
    setVisible(false);
  }

  async function enable() {
    if (!user || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const r = await enableOrderAlerts({
        userId: user.id,
        role: user.role,
        storeId: selectedStoreId,
      });
      // enabled or denied: the permission is no longer 'default', so the card never returns.
      if (r === 'enabled' || r === 'denied') setVisible(false);
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return <OrderAlertsModal busy={busy} failed={failed} onEnable={enable} onLater={dismiss} />;
}
