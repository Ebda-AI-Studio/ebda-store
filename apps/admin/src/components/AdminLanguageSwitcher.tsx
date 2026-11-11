'use client';

import { Button } from '@/components/ui/Button';
import { useEffect, useTransition } from 'react';
import { useLocale } from 'next-intl';
import { isLocale, type Locale } from '@/i18n/config';
import { persistLocale, restorableLocale } from '@/i18n/locale-storage';
import { useT } from '@/i18n/useT';

/**
 * One visible button naming the OTHER language in its own script
 * («English» on the Arabic UI, «العربية» on the English UI). Saves the choice
 * (cookie + localStorage) and reloads so the server re-renders `lang` + `dir`.
 */
export default function AdminLanguageSwitcher({ className = '' }: { className?: string }) {
  const active = useLocale();
  const [isPending, startTransition] = useTransition();
  const t = useT('components.languageSwitcher');

  // Cookie purged (ITP) but the saved choice survives → restore it once.
  useEffect(() => {
    const saved = restorableLocale(active);
    if (saved) {
      persistLocale(saved);
      window.location.reload();
    }
  }, [active]);

  const next: Locale = isLocale(active) && active === 'en' ? 'ar' : 'en';

  const change = () => {
    persistLocale(next);
    startTransition(() => {
      window.location.reload();
    });
  };

  return (
    <Button
      variant="outline"
      type="button"
      onClick={change}
      disabled={isPending}
      lang={next}
      dir={next === 'ar' ? 'rtl' : 'ltr'}
      aria-label={`${t('ariaLabel')}: ${next === 'ar' ? t('nativeAr') : t('nativeEn')}`}
      data-testid="language-toggle"
      className={className}
    >
      <svg
        className="h-4 w-4"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" strokeWidth={2} />
        <path
          strokeWidth={2}
          d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9S14.5 18.3 12 21c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"
        />
      </svg>
      {next === 'ar' ? t('nativeAr') : t('nativeEn')}
    </Button>
  );
}
