'use client';

import { StorePicker } from './StorePicker';
import { LangToggle } from './LangToggle';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAuth } from '@/lib/auth';

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
          <img src="/logo.svg" alt="Force AI Store" className="h-8 w-auto" width={38} height={32} />
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
