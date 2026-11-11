'use client';

import { useEffect, useState } from 'react';
import Link from './StoreLink';
import { useConsent } from '../contexts/ConsentContext';
import { useLanguage } from '../contexts/LanguageContext';
import { useStoreUrl } from '../contexts/StoreContext';
import { CONSENT_UI } from '@ebda/shared/tracking';

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
  'inline-flex min-h-11 items-center justify-center rounded-lg px-3 py-2 text-sm font-medium transition-colors md:px-5';

export function CookieConsentBanner() {
  const { hasDecided, setConsent, openPreferences } = useConsent();
  const { isRtl } = useLanguage();
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

  const c = CONSENT_UI[isRtl ? 'ar' : 'en'];

  // COOKIE-UI-1: the family's one cookie bar (words, order and height budget in @ebda/shared consent-ui).
  // On a phone it is a single compact bar (<= 12% of the viewport) above the tab bar: one short sentence with
  // the Customize link, then Reject and Accept as equals. Customize is a link, not a third button. From md it
  // is the roomy bar across the page.
  return (
    <div
      role="dialog"
      data-cookie-banner
      aria-modal="false"
      aria-label={c.label}
      aria-describedby="cookie-banner-body"
      className="fixed bottom-[calc(var(--bottom-tab-h)+env(safe-area-inset-bottom))] md:bottom-0 left-0 right-0 z-[100] border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 shadow-lg"
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      <div className="mx-auto max-w-7xl px-4 py-2 sm:px-6 md:py-4 lg:px-8">
        <div className="flex flex-col gap-1.5 md:flex-row md:items-center md:justify-between md:gap-6">
          <p
            id="cookie-banner-body"
            className="text-xs leading-snug text-muted-foreground md:text-sm md:leading-relaxed"
          >
            {c.text}{' '}
            <Link
              href={storeUrl('/privacy')}
              prefetch={false}
              className="underline hover:text-foreground"
            >
              {c.more}
            </Link>
            {' · '}
            <button
              type="button"
              data-consent="customize"
              onClick={openPreferences}
              className="underline underline-offset-4 hover:text-foreground"
            >
              {c.customize}
            </button>
          </p>

          {/* Reject and Accept are the SAME control (same fill, size, weight, one tap each): a regulator
              reads an accept-in-brand-colour / reject-outline pair as a dark pattern. Both take the neutral
              ink fill so neither pushes the brand. Two equal columns on a phone. */}
          <div className="grid grid-cols-2 gap-2 md:flex md:flex-shrink-0 md:gap-3">
            <button
              type="button"
              data-consent="reject"
              onClick={() => setConsent({ marketing: false })}
              className={`${CONSENT_BTN} bg-foreground text-background hover:bg-foreground/90`}
            >
              {c.reject}
            </button>
            <button
              type="button"
              data-consent="accept"
              onClick={() => setConsent({ marketing: true })}
              className={`${CONSENT_BTN} bg-foreground text-background hover:bg-foreground/90`}
            >
              {c.accept}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
