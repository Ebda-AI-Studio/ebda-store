'use client';

import { useEffect, useState } from 'react';
import type { SetupGuideState } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { apiGet } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useStore } from '../contexts/StoreContext';
import { enableOrderAlerts } from '../lib/push-opt-in';

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

/**
 * Quiet, inline ask for order alerts on the dashboard: in the page flow, never a modal or overlay.
 * Shown only when the browser supports push, permission is still 'default', the merchant is past
 * their first minutes (>= 1 order, or the required setup steps are done) and has not dismissed it.
 * The push SDK is NOT loaded here: only the click on the primary button calls enableOrderAlerts.
 */
export function OrderAlertsPromptCard({ storeId }: { storeId: string }) {
  const t = useT('components.orderAlertsPrompt');
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
      if (hasOrder || guideDone) setVisible(true);
    })();
    return () => {
      cancelled = true;
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

  return (
    <section
      aria-labelledby="order-alerts-prompt-title"
      className="relative mb-6 overflow-hidden rounded-xl border border-force-500/25 bg-force-950 p-4 text-force-100 md:p-5"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-force-400 to-transparent"
      />
      <div className="flex items-start gap-3 md:gap-4">
        <span
          aria-hidden="true"
          className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-force-500/40 text-force-400"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.7 21a2 2 0 01-3.4 0" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="order-alerts-prompt-title" className="text-base font-semibold text-force-50">
            {t('title')}
          </h2>
          <p className="mt-0.5 text-sm text-force-300">{t('body')}</p>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <button
              type="button"
              onClick={enable}
              disabled={busy}
              className="inline-flex min-h-11 items-center rounded-lg bg-force-400 px-4 text-sm font-semibold text-force-950 transition-colors hover:bg-force-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-force-300 focus-visible:ring-offset-2 focus-visible:ring-offset-force-950 disabled:opacity-60"
            >
              {busy ? t('enabling') : t('cta')}
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="inline-flex min-h-11 items-center rounded-md px-1 text-sm text-force-300 underline-offset-4 hover:text-force-100 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-force-300"
            >
              {t('later')}
            </button>
            <p role="status" aria-live="polite" className="text-sm text-force-300">
              {failed && t('error')}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
