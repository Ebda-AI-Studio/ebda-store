import type { CSSProperties, ReactNode } from 'react';
import Script from 'next/script';
import { IBM_Plex_Sans_Arabic } from 'next/font/google';
import { BRAND } from '@ebda/shared/brand';
import { type Locale } from '../lib/site';
import { EbdaTracking } from './EbdaTracking';
import '@/app/globals.css';
import '@/app/motifs.css';
import '@/app/chrome.css';
import '@/app/services-chrome.css';

/**
 * SEO-5: fonts are self-hosted at build by next/font (no fonts.googleapis.com / gstatic request, no
 * render-blocking stylesheet, display swap, size-adjusted fallback, hashed files served immutable).
 * DS-FONT-1: ONE family for Arabic and Latin, IBM Plex Sans Arabic 400/500/600 (BRAND.fonts mirrors it).
 */
const plex = IBM_Plex_Sans_Arabic({
  subsets: ['arabic', 'latin'],
  variable: '--nf-ar',
  display: 'swap',
  weight: ['400', '500', '600'],
});

/** Brand tokens come from BRAND (single source of truth); everything else lives in globals.css. */
const tokens = {
  '--night': BRAND.colors.night,
  '--gold': BRAND.colors.gold,
  '--lift': BRAND.colors.lift,
  '--font-ar': 'var(--nf-ar), ui-sans-serif, system-ui, sans-serif',
  '--font-sans': 'var(--nf-ar), ui-sans-serif, system-ui, sans-serif',
} as CSSProperties;

/** `<html>` shell per locale (Arabic RTL default, English LTR). */
export function RootShell({ locale, children }: { locale: Locale; children: ReactNode }) {
  return (
    <html
      lang={locale}
      dir={locale === 'ar' ? 'rtl' : 'ltr'}
      // globals.css sets `scroll-behavior: smooth` on html. Next's router only turns that off while it
      // resets the scroll after a navigation when this attribute is present; without it the reset is
      // animated, races the router's own scrollIntoView and a page can open at its footer.
      data-scroll-behavior="smooth"
      style={tokens}
      className={plex.variable}
    >
      <body>
        {children}
        <EbdaTracking />
        {/* the shared header-nav behaviour (Esc, click-outside, one menu open, aria-expanded): a static same-origin file */}
        <script src="/site-nav.js" defer />
        {/* The live search box (header + 404): one script for the whole site, after hydration. */}
        <Script src="/assets/typeahead.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
