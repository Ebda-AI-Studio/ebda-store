'use client';

import { useLanguage } from '@/contexts/LanguageContext';

export function LangToggle() {
  const { locale, toggle } = useLanguage();
  return (
    <button
      type="button"
      onClick={toggle}
      className="inline-flex h-9 min-w-9 items-center justify-center rounded-full border border-border bg-card px-3 text-xs font-semibold text-foreground"
      aria-label={locale === 'en' ? 'التبديل إلى العربية' : 'Switch to English'}
    >
      {locale === 'en' ? 'ع' : 'EN'}
    </button>
  );
}
