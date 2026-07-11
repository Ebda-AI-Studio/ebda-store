'use client';

import { useLanguage } from '@/contexts/LanguageContext';

/**
 * Editorial 404 banner shown above the hero on the not-found page — signals the
 * wrong URL without losing the platform pitch below. Dark/orange to match the
 * editorial landing (replaces the old amber banner from PlatformLanding).
 */
export function LandingNotFoundBanner() {
  const { language } = useLanguage();
  return (
    <div className="border-b border-primary/25 bg-primary/[0.08] px-4 py-3 text-center text-sm text-primary/90">
      <strong className="font-semibold">404 — </strong>
      {language === 'ar'
        ? 'هذا المتجر غير موجود على منصتنا. تعرّف على ما نقدّمه أدناه.'
        : 'That store doesn’t exist on our platform. Here’s what we offer.'}
    </div>
  );
}
