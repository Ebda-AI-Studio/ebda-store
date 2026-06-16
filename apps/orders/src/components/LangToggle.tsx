'use client';

import { useLanguage } from '@/contexts/LanguageContext';

export function LangToggle() {
  const { locale, toggle } = useLanguage();
  return (
    <button
      type="button"
      onClick={toggle}
      className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-full border border-border bg-card px-3 text-xs font-semibold text-foreground active:bg-muted/60"
      aria-label={locale === 'en' ? 'التبديل إلى العربية' : 'Switch to English'}
    >
      {locale === 'en' ? 'ع' : 'EN'}
    </button>
  );
}
