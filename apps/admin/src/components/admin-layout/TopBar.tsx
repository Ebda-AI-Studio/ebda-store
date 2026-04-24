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
    <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-border/50 bg-card/80 px-4 backdrop-blur-md lg:px-6">
      <div className="flex items-center gap-4">
        {/* Mobile menu button */}
        <button
          onClick={onOpenSidebar}
          className="flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
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
            onClick={onBack}
            className="flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
        <div>
          <h1 className="text-lg font-bold text-foreground">{title}</h1>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {/* Notifications */}
        <NotificationBell />

        {/* View Store — links to the storefront for the current store */}
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
        {actions}
      </div>
    </header>
  );
}
