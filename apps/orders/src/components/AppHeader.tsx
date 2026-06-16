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
        className="mx-auto flex max-w-2xl items-center justify-between gap-2 px-4 py-3"
        style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}
      >
        <div className="flex items-center gap-2">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-sm font-black text-primary-foreground">
            F
          </span>
          <h1 className="text-base font-bold text-foreground">{t.orders.title}</h1>
        </div>
        <div className="flex items-center gap-2">
          <StorePicker />
          <LangToggle />
          <button
            type="button"
            onClick={logout}
            className="inline-flex h-9 items-center rounded-full border border-border bg-card px-3 text-xs font-semibold text-foreground"
          >
            {t.nav.logout}
          </button>
        </div>
      </div>
    </header>
  );
}
