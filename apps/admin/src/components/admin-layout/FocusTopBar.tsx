'use client';

import { useState, useEffect } from 'react';
import OneSignal from 'react-onesignal';
import { NotificationBell } from '../NotificationBell';
import { useFocusMode } from '@/contexts/FocusModeContext';
import { useT } from '@/i18n/useT';
import type { StoreBranding } from './buildStoreAdminNav';

interface FocusTopBarProps {
  storeBranding?: StoreBranding;
}

/**
 * Minimal top bar shown instead of the full TopBar when focus mode is ON.
 *
 * Surfaces:
 *  - Store name (or "Orders" fallback)
 *  - Notification bell (reused as-is)
 *  - OneSignal opt-in nudge when the device isn't subscribed
 *  - Exit focus mode button
 */
export function FocusTopBar({ storeBranding }: FocusTopBarProps) {
  const t = useT('components.adminLayout');
  const { exitFocusMode } = useFocusMode();
  const [isSubscribed, setIsSubscribed] = useState<boolean | null>(null);
  const [isSubscribing, setIsSubscribing] = useState(false);

  // Check OneSignal subscription state once on mount. We can't read
  // this synchronously because OneSignalInit runs async; wait a tick.
  useEffect(() => {
    const check = () => {
      try {
        const optedIn = OneSignal.User?.PushSubscription?.optedIn ?? null;
        setIsSubscribed(optedIn === true);
      } catch {
        // OneSignal SDK not yet available — skip nudge silently.
        setIsSubscribed(null);
      }
    };

    const timer = window.setTimeout(check, 1_000);
    return () => window.clearTimeout(timer);
  }, []);

  async function handleEnableNotifications() {
    if (isSubscribing) return;
    setIsSubscribing(true);
    try {
      await OneSignal.User?.PushSubscription?.optIn();
      setIsSubscribed(true);
    } catch {
      // Permission denied or SDK error — fail silently.
    } finally {
      setIsSubscribing(false);
    }
  }

  const storeName = storeBranding?.name ?? t('focusMode.ordersOnly');

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-border/50 bg-card/80 px-4 backdrop-blur-md lg:h-16 lg:px-6">
      {/* Left: store identity */}
      <div className="flex min-w-0 items-center gap-2">
        {storeBranding?.logo && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={storeBranding.logo}
            alt={storeName}
            className="h-7 w-7 shrink-0 rounded-md object-cover"
          />
        )}
        <span className="truncate text-sm font-semibold text-foreground">{storeName}</span>
        <span className="hidden shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary-ink sm:inline-flex">
          {t('focusMode.ordersOnly')}
        </span>
      </div>

      {/* Right: bell + nudge + exit */}
      <div className="flex shrink-0 items-center gap-2">
        {/* OneSignal opt-in nudge — only when we know the device isn't
            subscribed yet. Null means we haven't checked yet (hide). */}
        {isSubscribed === false && (
          <button
            type="button"
            onClick={handleEnableNotifications}
            disabled={isSubscribing}
            className="hidden items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary-ink transition-colors hover:bg-primary/10 disabled:opacity-60 sm:flex"
            aria-label={t('focusMode.enableNotifications')}
          >
            <svg
              className="h-3.5 w-3.5 shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
              />
            </svg>
            {isSubscribing ? '…' : t('focusMode.enableNotifications')}
          </button>
        )}

        <NotificationBell />

        {/* Exit focus mode */}
        <button
          type="button"
          onClick={exitFocusMode}
          className="flex h-11 w-11 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={t('focusMode.exitFocusMode')}
          title={t('focusMode.exitFocusMode')}
        >
          <svg
            className="h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            {/* X / close icon */}
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>
    </header>
  );
}
