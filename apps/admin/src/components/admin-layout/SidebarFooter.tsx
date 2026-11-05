'use client';

import Link from 'next/link';
import { useFocusMode } from '@/contexts/FocusModeContext';
import { useT } from '@/i18n/useT';

interface SidebarFooterUser {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}

interface SidebarFooterProps {
  isDark: boolean;
  onToggleTheme: () => void;
  user: SidebarFooterUser | null | undefined;
  onLogout: () => void;
  /** When provided, the footer shows an "Enter focus mode" button. */
  storeId?: string | null;
}

export function SidebarFooter({
  isDark,
  onToggleTheme,
  user,
  onLogout,
  storeId,
}: SidebarFooterProps) {
  const t = useT('components.adminLayout');
  const { enterFocusMode } = useFocusMode();

  return (
    <>
      {/* Focus Mode Entry — only shown when a store is in scope */}
      {storeId && (
        <div className="px-4 pb-2">
          <button
            type="button"
            onClick={() => enterFocusMode(storeId)}
            className="flex w-full items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            title={t('focusMode.focusModeHint')}
          >
            <svg
              className="h-4 w-4 shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              {/* Target / focus icon */}
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.75}
                d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
              />
            </svg>
            <span className="flex-1 text-start">{t('focusMode.enterFocusMode')}</span>
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground/70">
              {t('focusMode.ordersOnly')}
            </span>
          </button>
          <p className="mt-1.5 px-1 text-xs leading-snug text-muted-foreground">
            {t('focusMode.focusModeHint')}
          </p>
        </div>
      )}

      {/* Theme toggle. The language switcher lives in the top bar only (audit G-4: it appeared twice). */}
      <div className="flex items-center justify-end gap-2 px-4 pb-2">
        <button
          type="button"
          onClick={onToggleTheme}
          className="flex h-11 w-11 items-center justify-center rounded-lg border border-border/60 bg-muted/40 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary cursor-pointer"
          aria-label={isDark ? t('switchToLight') : t('switchToDark')}
        >
          {isDark ? (
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
                d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
              />
            </svg>
          ) : (
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
                d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
              />
            </svg>
          )}
        </button>
      </div>

      {/* User Profile Section */}
      <div className="border-t border-border/50 p-4">
        <div className="flex items-center gap-3 rounded-xl bg-muted/50 p-3 transition-colors hover:bg-muted">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary/20 to-primary/10 text-sm font-bold text-primary">
            {user?.firstName?.[0]}
            {user?.lastName?.[0]}
          </div>
          <div className="flex-1 min-w-0">
            {/* Truncate the END of the text, never the identifying part (audit G-6). An e-mail is LTR text inside an
                RTL chip: dir=ltr keeps its start visible and the ellipsis on the right; the name follows its own script. */}
            <p dir="auto" className="text-sm font-semibold text-foreground truncate text-start">
              {user?.firstName} {user?.lastName}
            </p>
            <p
              dir="ltr"
              title={user?.email ?? undefined}
              className="text-xs text-muted-foreground truncate rtl:text-right"
            >
              {user?.email}
            </p>
          </div>
          <Link
            href="/account/security"
            className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={t('security')}
            title={t('security')}
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
                strokeWidth={1.5}
                d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
              />
            </svg>
          </Link>
          <button
            type="button"
            onClick={onLogout}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            aria-label={t('logout')}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
              />
            </svg>
          </button>
        </div>
      </div>
    </>
  );
}
