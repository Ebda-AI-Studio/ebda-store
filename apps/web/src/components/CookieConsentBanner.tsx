'use client';

import Link from 'next/link';
import { useConsent } from '../contexts/ConsentContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useStoreUrl } from '../contexts/StoreContext';

/**
 * Bottom-anchored cookie consent banner. Only renders when the visitor
 * hasn't yet made a consent decision (no `force-cookie-consent` cookie).
 *
 * Three options:
 *   - Accept all     → marketing=true, cookie written, page reloads
 *   - Reject all     → marketing=false, cookie written, page reloads
 *   - Customize      → opens the CookiePreferencesModal for granular control
 *
 * Regulatory context: required by GDPR Art. 6(a), ePrivacy Directive,
 * and applicable GCC data-protection law (see
 * docs/legal/gcc-data-protection.md). The "Reject"
 * option must be as prominent and easy to click as "Accept" — that's
 * why both are primary-style buttons, not "Accept" prominent + "Reject"
 * buried in a sub-menu (a pattern regulators have specifically flagged
 * as "dark patterns" / non-compliant).
 */
export function CookieConsentBanner() {
  const { hasDecided, setConsent, openPreferences } = useConsent();
  const { t, isRtl } = useLanguage();
  const storeUrl = useStoreUrl();

  // Don't render once the user has decided. The footer "Cookie preferences"
  // link is how they get back to change their mind later.
  if (hasDecided) return null;

  // Suppress in admin live-preview iframe context. Ahmad 2026-05-20: the
  // banner kept reappearing in the page-builder preview every iframe reload
  // because the iframe is a separate browsing context with no consent cookie.
  // Two signals — `window.top !== window.self` (we're framed) AND the
  // `?_preview=` query param (admin live-preview injects it). Either one is
  // sufficient. Real visitors hit the storefront top-level and see the
  // banner normally.
  if (typeof window !== 'undefined') {
    const inIframe = window.top !== window.self;
    const hasPreviewParam =
      window.location.search.includes('_preview=') ||
      window.location.search.includes('_layoutDraft=');
    if (inIframe || hasPreviewParam) return null;
  }

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="cookie-banner-title"
      aria-describedby="cookie-banner-body"
      className="fixed bottom-[calc(56px+env(safe-area-inset-bottom))] md:bottom-0 left-0 right-0 z-[100] border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 shadow-lg"
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex-1">
            <h2 id="cookie-banner-title" className="text-base font-semibold text-foreground">
              {t('We use cookies', 'نستخدم ملفات تعريف الارتباط')}
            </h2>
            <p
              id="cookie-banner-body"
              className="mt-1 text-sm text-muted-foreground leading-relaxed"
            >
              {t(
                'We use essential cookies to run the store and optional marketing cookies to measure ads. You can accept, reject, or choose what to allow.',
                'نستخدم ملفات أساسية لتشغيل المتجر وملفات تسويقية اختيارية لقياس الإعلانات. يمكنك القبول أو الرفض أو اختيار ما تسمح به.'
              )}{' '}
              <Link
                href={storeUrl('/privacy')}
                prefetch={false}
                className="underline hover:text-foreground"
              >
                {t('Learn more', 'اعرف المزيد')}
              </Link>
            </p>
          </div>

          {/* Three buttons. Accept + Reject are visually equivalent (no
              dark-pattern hierarchy). Customize is secondary. */}
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-3 sm:flex-shrink-0">
            <button
              type="button"
              onClick={() => setConsent({ marketing: false })}
              className="inline-flex items-center justify-center min-h-11 rounded-lg border border-border bg-background px-5 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
            >
              {t('Reject all', 'رفض الكل')}
            </button>
            <button
              type="button"
              onClick={openPreferences}
              className="inline-flex items-center justify-center min-h-11 rounded-lg border border-border bg-background px-5 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
            >
              {t('Customize', 'تخصيص')}
            </button>
            <button
              type="button"
              onClick={() => setConsent({ marketing: true })}
              className="inline-flex items-center justify-center min-h-11 rounded-lg bg-primary px-5 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors"
            >
              {t('Accept all', 'قبول الكل')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
