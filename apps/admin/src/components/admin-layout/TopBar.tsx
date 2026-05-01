'use client';

import Link from 'next/link';
import { Button } from '@force/ui';
import { NotificationBell } from '../NotificationBell';
import { useT } from '@/i18n/useT';

interface TopBarProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  showBackButton: boolean;
  onOpenSidebar: () => void;
  onBack: () => void;
  viewStoreUrl: string | null;
}

export function TopBar({
  title,
  subtitle,
  actions,
  showBackButton,
  onOpenSidebar,
  onBack,
  viewStoreUrl,
}: TopBarProps) {
  const t = useT('components.adminLayout');

  return (
    <header className="sticky top-0 z-20 border-b border-border/50 bg-card/80 backdrop-blur-md">
      {/* Primary row — title + bell. Actions live below this on mobile
          (see the mobile-only second row) and inline on desktop. The
          header is no longer fixed-height: it absorbs whatever the
          actions strip needs without clipping wrapped buttons. */}
      <div className="flex h-14 items-center justify-between gap-2 px-4 lg:h-16 lg:px-6">
        <div className="flex min-w-0 items-center gap-2 lg:gap-4">
          <button
            type="button"
            onClick={onOpenSidebar}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
            aria-label={t('openSidebar')}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6h16M4 12h16M4 18h16"
              />
            </svg>
          </button>
          {showBackButton && (
            <button
              type="button"
              onClick={onBack}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label={t('goBack')}
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
          )}
          <div className="min-w-0">
            <h1 className="truncate text-base font-bold text-foreground lg:text-lg">{title}</h1>
            {/* Subtitle hides on mobile — repeats info that's already
                clear from the page context and ate header height when
                actions had to share the row. */}
            {subtitle && (
              <p className="hidden truncate text-xs text-muted-foreground lg:block">{subtitle}</p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 lg:gap-3">
          <NotificationBell />

          {viewStoreUrl && (
            <Link href={viewStoreUrl} target="_blank" className="hidden sm:block">
              <Button variant="outline" size="sm" className="gap-2 rounded-xl">
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                  />
                </svg>
                {t('viewStore')}
              </Button>
            </Link>
          )}
          {/* Desktop: actions inline alongside the bell. Mobile: actions
              get their own dedicated row below (see secondary row). */}
          {actions && <div className="hidden lg:flex lg:items-center lg:gap-3">{actions}</div>}
        </div>
      </div>

      {/* Mobile-only secondary row for the page actions. Horizontal
          scroll prevents 3+ buttons from wrapping into 2-line stacks
          (the previous bug — see the products screenshot where every
          action button broke onto 2-3 lines). `[&_*]:shrink-0` keeps
          inner Button + Link wrappers from shrinking inside the scroll
          strip. */}
      {actions && (
        <div className="lg:hidden">
          <div className="-mx-2 flex items-center gap-2 overflow-x-auto px-4 pb-2 [&_*]:shrink-0">
            {actions}
          </div>
        </div>
      )}
    </header>
  );
}
