'use client';

import { useEffect, useRef, useState } from 'react';
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

const MOTION_CSS = `@keyframes ebda-alerts-fade{from{opacity:0}to{opacity:1}}@keyframes ebda-alerts-pop{from{opacity:0;transform:scale(.96) translateY(6px)}to{opacity:1;transform:none}}`;

const FOCUSABLE =
  'button:not([disabled]),[href],input,select,textarea,[tabindex]:not([tabindex="-1"])';

/**
 * Order-alerts ask: a centred, Ebda-styled modal dialog. Shown only when the browser supports push, permission is
 * still 'default', the merchant has >= 1 order or finished the required setup steps, it was not dismissed in the last
 * 14 days, no other dialog is open, and it is not the first page view of the session. Esc / "later" = dismiss.
 * The push SDK is NOT loaded here: only the primary button calls enableOrderAlerts.
 */
export function OrderAlertsPromptCard({ storeId }: { storeId: string }) {
  const t = useT('components.orderAlertsPrompt');
  const { user } = useAuth();
  const { selectedStoreId } = useStore();
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);
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
          returnFocusTo.current = document.activeElement as HTMLElement | null;
          setVisible(true);
        }
      }, graceRemainingMs());
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [userId, isStaffRole, storeId]);

  useEffect(() => {
    if (!visible) return;
    const node = dialogRef.current;
    node?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    const restore = returnFocusTo.current;
    return () => restore?.focus?.();
  }, [visible]);

  if (!visible || !user) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(orderAlertsDismissKey(user!.id), String(Date.now()));
    } catch {
      // storage blocked: the card simply hides for this visit
    }
    setVisible(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      dismiss();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
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
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm motion-safe:animate-[ebda-alerts-fade_220ms_ease-out]"
      onKeyDown={onKeyDown}
    >
      <style>{MOTION_CSS}</style>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-alerts-prompt-title"
        aria-describedby="order-alerts-prompt-body"
        className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-force-500/40 bg-force-950 p-7 text-center text-force-100 shadow-2xl motion-safe:animate-[ebda-alerts-pop_260ms_cubic-bezier(.2,.8,.2,1)]"
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-force-400 to-transparent"
        />
        <span
          aria-hidden="true"
          className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-force-500/40 text-force-400"
        >
          <svg
            width="22"
            height="22"
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
        <h2 id="order-alerts-prompt-title" className="mt-5 text-lg font-semibold text-force-50">
          {t('title')}
        </h2>
        <p id="order-alerts-prompt-body" className="mt-2 text-sm leading-relaxed text-force-300">
          {t('body')}
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <button
            type="button"
            data-autofocus
            onClick={enable}
            disabled={busy}
            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-force-400 px-4 text-sm font-semibold text-force-950 transition-colors hover:bg-force-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-force-300 focus-visible:ring-offset-2 focus-visible:ring-offset-force-950 disabled:opacity-60"
          >
            {busy ? t('enabling') : t('cta')}
          </button>
          <button
            type="button"
            onClick={dismiss}
            className="inline-flex min-h-11 items-center justify-center rounded-lg px-4 text-sm text-force-300 transition-colors hover:text-force-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-force-300"
          >
            {t('later')}
          </button>
        </div>
        <p role="status" aria-live="polite" className="mt-2 min-h-5 text-sm text-force-300">
          {failed && t('error')}
        </p>
      </div>
    </div>
  );
}
