'use client';

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
 *  - Exit focus mode button
 */
export function FocusTopBar({ storeBranding }: FocusTopBarProps) {
  const t = useT('components.adminLayout');
  const { exitFocusMode } = useFocusMode();
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

      {/* Right: bell + exit */}
      <div className="flex shrink-0 items-center gap-2">
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
