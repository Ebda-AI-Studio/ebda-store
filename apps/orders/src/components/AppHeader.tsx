'use client';

import { StorePicker } from './StorePicker';
import { LangToggle } from './LangToggle';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAuth } from '@/lib/auth';
import { BRAND } from '@force/shared';

export function AppHeader() {
  const { t } = useLanguage();
  const { logout } = useAuth();

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur">
      <div
        className="mx-auto flex max-w-2xl items-center justify-between gap-2 px-4 pb-2"
        style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.5rem)' }}
      >
        <div className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo-on-light.svg"
            alt={BRAND.name}
            className="h-8 w-8 dark:hidden"
            width={32}
            height={32}
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.svg"
            alt={BRAND.name}
            className="hidden h-8 w-8 dark:block"
            width={32}
            height={32}
          />
          <h1 className="text-base font-bold text-foreground">{t.orders.title}</h1>
        </div>
        <div className="flex items-center gap-1.5">
          <StorePicker />
          <LangToggle />
          <button
            type="button"
            onClick={logout}
            className="inline-flex h-11 min-w-[44px] items-center rounded-full border border-border bg-card px-3 text-xs font-semibold text-foreground active:bg-muted/60"
          >
            {t.nav.logout}
          </button>
        </div>
      </div>
    </header>
  );
}
