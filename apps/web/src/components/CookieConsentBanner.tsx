'use client';

import { useEffect, useState } from 'react';
import Link from './StoreLink';
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
 * docs/privacy/data-map.md). The "Reject"
 * option must be as prominent and easy to click as "Accept" — that's
 * why both are primary-style buttons, not "Accept" prominent + "Reject"
 * buried in a sub-menu (a pattern regulators have specifically flagged
 * as "dark patterns" / non-compliant).
 */
const CONSENT_BTN =
  'inline-flex min-h-11 items-center justify-center rounded-lg px-3 py-2 text-sm font-medium transition-colors sm:px-5';

export function CookieConsentBanner() {
  const { hasDecided, setConsent, openPreferences } = useConsent();
  const { t, isRtl } = useLanguage();
  const storeUrl = useStoreUrl();
  // Admin live-preview iframe (see below). Read AFTER mount: window.top / location are not
  // known on the server, so reading them during render hydrated differently in the iframe.
  const [inPreviewFrame, setInPreviewFrame] = useState(false);
  useEffect(() => {
    const inIframe = window.top !== window.self;
    const hasPreviewParam =
      window.location.search.includes('_preview=') ||
      window.location.search.includes('_layoutDraft=');
    setInPreviewFrame(inIframe || hasPreviewParam);
  }, []);

  // Audit 2026-11-03 #8: the strip is a fixed element in the first HTML, and the Arabic web font swapping in
  // re-wrapped its text (+/- 23 px of height) after first paint: two layout shifts on every first visit
  // (0.03 each). It now mounts once fonts are ready (or after 1.2 s, whichever is first), so it is laid out
  // once, with its final text metrics. It is a consent notice, not content: 1.2 s at most is not a delay a
  // regulator reads as hiding the choice, and no tracking runs before it either way.
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    let done = false;
    const go = () => {
      if (!done) {
        done = true;
        setFontsReady(true);
      }
    };
    const timer = setTimeout(go, 1200);
    document.fonts?.ready.then(go, go);
    return () => {
      done = true;
      clearTimeout(timer);
    };
  }, []);

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
  if (inPreviewFrame) return null;

  if (!fontsReady) return null;

  return (
    <div
      role="dialog"
      data-cookie-banner
      aria-modal="false"
      aria-labelledby="cookie-banner-title"
      aria-describedby="cookie-banner-body"
      className="fixed bottom-[calc(var(--bottom-tab-h)+env(safe-area-inset-bottom))] md:bottom-0 left-0 right-0 z-[100] border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 shadow-lg"
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 sm:py-6 lg:px-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="flex-1">
            {/* Audit 2026-11-03 #6: on a phone the banner is a compact strip (the title is read by
                assistive tech only, the sentence is 12 px), so it no longer takes a third of the
                hero. From sm it is the roomy bar it was. */}
            <h2
              id="cookie-banner-title"
              className="sr-only text-base font-semibold text-foreground sm:not-sr-only"
            >
              {t('We use cookies', 'نستخدم ملفات تعريف الارتباط')}
            </h2>
            <p
              id="cookie-banner-body"
              className="text-xs leading-snug text-muted-foreground sm:mt-1 sm:text-sm sm:leading-relaxed"
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

          {/* Accept and Reject are the SAME control (same fill, size, weight, one tap each): a
              regulator reads an accept-in-brand-colour / reject-outline pair as a dark pattern, and
              the old markup did exactly that (bg-primary vs border). Both take the neutral ink fill,
              so neither pushes the brand. Customize is the quieter outline between them. Three equal
              columns on a phone, so nothing wraps into a stack of full-width bars. */}
          <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-shrink-0 sm:gap-3">
            <button
              type="button"
              data-consent="reject"
              onClick={() => setConsent({ marketing: false })}
              className={`${CONSENT_BTN} bg-foreground text-background hover:bg-foreground/90`}
            >
              {t('Reject all', 'رفض الكل')}
            </button>
            <button
              type="button"
              data-consent="customize"
              onClick={openPreferences}
              className={`${CONSENT_BTN} border border-input bg-background text-foreground hover:bg-muted`}
            >
              {t('Customize', 'تخصيص')}
            </button>
            <button
              type="button"
              data-consent="accept"
              onClick={() => setConsent({ marketing: true })}
              className={`${CONSENT_BTN} bg-foreground text-background hover:bg-foreground/90`}
            >
              {t('Accept all', 'قبول الكل')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
