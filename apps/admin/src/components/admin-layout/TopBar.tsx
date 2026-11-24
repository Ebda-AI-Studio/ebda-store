'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, buttonVariants } from '@/components/ui/Button';
import { NotificationBell } from '../NotificationBell';
import { LaunchReadinessChip } from './LaunchReadinessChip';
import AdminLanguageSwitcher from '../AdminLanguageSwitcher';
import { DocumentTitle } from '../DocumentTitle';
import { useT } from '@/i18n/useT';
import { ArrowStart } from '../ArrowStart';

interface TopBarProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  showBackButton: boolean;
  isSidebarOpen?: boolean;
  onOpenSidebar: () => void;
  onBack: () => void;
  viewStoreUrl: string | null;
  /** Breadcrumb parent (UX:N-5): a quiet link above the title that goes up one level. */
  parent?: { label: string; href: string };
}

export function TopBar({
  title,
  subtitle,
  actions,
  showBackButton,
  isSidebarOpen = false,
  onOpenSidebar,
  onBack,
  viewStoreUrl,
  parent,
}: TopBarProps) {
  const t = useT('components.adminLayout');
  // One h1 per page (audit G-7): when the page body renders its own h1, the bar title is a plain paragraph so a
  // screen reader does not get the same heading twice. Pages without an h1 keep this one.
  const [pageHasOwnH1, setPageHasOwnH1] = useState(false);
  useEffect(() => {
    const main = document.getElementById('admin-main-content');
    if (!main) return;
    const check = () =>
      setPageHasOwnH1(Array.from(main.querySelectorAll('h1')).some(h => !h.closest('header')));
    check();
    const observer = new MutationObserver(check);
    observer.observe(main, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [title]);
  const TitleTag = pageHasOwnH1 ? 'p' : 'h1';

  return (
    <header className="sticky top-0 z-20 border-b border-border/50 bg-card/80 backdrop-blur-md">
      <DocumentTitle title={title} />
      {/* Primary row — title + bell. Actions live below this on mobile
          (see the mobile-only second row) and inline on desktop. The
          header is no longer fixed-height: it absorbs whatever the
          actions strip needs without clipping wrapped buttons. */}
      <div className="flex h-14 items-center justify-between gap-2 px-4 lg:h-16 lg:px-6">
        <div className="flex min-w-0 items-center gap-2 lg:gap-4">
          <Button
            variant="ghost"
            size="icon"
            type="button"
            onClick={onOpenSidebar}
            className="shrink-0 justify-center text-muted-foreground lg:hidden"
            aria-label={t('openSidebar')}
            aria-expanded={isSidebarOpen}
            aria-controls="admin-mobile-sidebar"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6h16M4 12h16M4 18h16"
              />
            </svg>
          </Button>
          {showBackButton && (
            <Button
              variant="ghost"
              size="icon"
              type="button"
              onClick={onBack}
              className="shrink-0 justify-center text-muted-foreground"
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
            </Button>
          )}
          <div className="min-w-0">
            {parent && (
              <Link
                href={parent.href}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ArrowStart className="h-3 w-3" />
                {parent.label}
              </Link>
            )}
            <TitleTag className="truncate text-xl font-semibold text-foreground">{title}</TitleTag>
            {/* Subtitle hides on mobile — repeats info that's already
                clear from the page context and ate header height when
                actions had to share the row. */}
            {subtitle && (
              <p className="hidden truncate text-sm text-muted-foreground lg:block">{subtitle}</p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 lg:gap-3">
          <LaunchReadinessChip />
          <AdminLanguageSwitcher />
          <NotificationBell />

          {viewStoreUrl && (
            <Link
              href={viewStoreUrl}
              target="_blank"
              className={buttonVariants({ variant: 'outline', className: 'hidden sm:inline-flex' })}
            >
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
            </Link>
          )}
          {/* Desktop: actions inline alongside the bell. Mobile: actions
              get their own dedicated row below (see secondary row). */}
          {actions && <div className="hidden lg:flex lg:items-center lg:gap-3">{actions}</div>}
        </div>
      </div>

      {/* Mobile-only secondary row for the page actions. Use
          flex-wrap so buttons that don't fit wrap to a second line
          rather than getting hidden in an off-screen horizontal
          scroll strip — merchants reported the rightmost action
          (e.g. "Recommendations" on the product detail page) appearing
          to be missing because it sat off-screen with no visual scroll
          hint. Letting them wrap is uglier but every button stays
          visible without discovery. */}
      {actions && (
        <div className="lg:hidden">
          {/* Most pages pass `actions` as `<div className="flex gap-2">`
              (a nowrap flex). On a 360-390px phone viewport that
              container's width pushed 3rd/4th buttons (e.g.
              "Recommendations" / "Delete" on the product page) past
              the right edge with no scroll affordance — merchants
              reported the buttons as "missing".
              `[&>div]:contents` collapses that wrapper so the buttons
              become direct flex children of OUR row below — then our
              `flex-wrap` actually wraps them onto a second line
              instead of being trapped inside the page's nowrap flex. */}
          <div className="flex flex-wrap items-center gap-2 px-4 pb-2 [&>div]:contents">
            {actions}
          </div>
        </div>
      )}
    </header>
  );
}
