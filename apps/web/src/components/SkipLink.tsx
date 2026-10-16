'use client';

import { useLanguage } from '../contexts/LanguageContext';

/** First stop in the tab order: jump past the header to the page (R-05: named in the page's language). */
export function SkipLink() {
  const { t } = useLanguage();
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:start-4 focus:z-[9999] focus:rounded-lg focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
    >
      {t('Skip to main content', 'تخطَّ إلى المحتوى الرئيسي')}
    </a>
  );
}
