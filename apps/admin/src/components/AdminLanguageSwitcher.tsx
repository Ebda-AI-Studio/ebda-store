'use client';

import { useLocale } from 'next-intl';
import { useTransition } from 'react';
import { isLocale, localeCookieName, type Locale } from '@/i18n/config';
import { useT } from '@/i18n/useT';

function setLocaleCookie(locale: Locale) {
  const oneYear = 60 * 60 * 24 * 365;
  document.cookie = `${localeCookieName}=${locale}; path=/; max-age=${oneYear}; SameSite=Lax`;
}

export default function AdminLanguageSwitcher() {
  const active = useLocale();
  const [isPending, startTransition] = useTransition();
  const t = useT('components.languageSwitcher');

  const change = (next: Locale) => {
    if (next === active) return;
    setLocaleCookie(next);
    startTransition(() => {
      window.location.reload();
    });
  };

  return (
    <div
      role="group"
      aria-label={t('ariaLabel')}
      className="flex items-center gap-1 rounded-lg border border-border/60 bg-muted/40 p-1 text-xs"
    >
      {(['en', 'ar'] as const).map(loc => {
        const isActive = isLocale(active) && active === loc;
        return (
          <button
            key={loc}
            type="button"
            onClick={() => change(loc)}
            disabled={isPending}
            aria-pressed={isActive}
            className={`min-w-[44px] min-h-[32px] rounded-md px-2.5 py-1 font-semibold uppercase tracking-wide transition-colors disabled:opacity-60 cursor-pointer ${
              isActive
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {loc === 'en' ? 'EN' : 'ع'}
          </button>
        );
      })}
    </div>
  );
}
