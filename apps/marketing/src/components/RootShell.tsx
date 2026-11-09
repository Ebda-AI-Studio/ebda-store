import type { CSSProperties, ReactNode } from 'react';
import Script from 'next/script';
import { Geist, Geist_Mono, IBM_Plex_Sans_Arabic } from 'next/font/google';
import { BRAND } from '@ebda/shared/brand';
import { type Locale } from '../lib/site';
import { EbdaTracking } from './EbdaTracking';
import '@/app/globals.css';
import '@/app/motifs.css';
import '@/app/chrome.css';
import '@/app/about.css';
import '@/app/contact.css';
import '@/app/services-chrome.css';

/**
 * SEO-5: fonts are self-hosted at build by next/font (no fonts.googleapis.com / gstatic request, no
 * render-blocking stylesheet, display swap, size-adjusted fallback, hashed files served immutable).
 * Families and weights mirror BRAND.fonts (Geist, Geist Mono, IBM Plex Sans Arabic 400/500/700).
 */
const geist = Geist({ subsets: ['latin'], variable: '--nf-sans', display: 'swap' });
const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--nf-mono',
  display: 'swap',
  weight: ['400', '500'],
});
const plexArabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic'],
  variable: '--nf-ar',
  display: 'swap',
  weight: ['400', '500', '700'],
});

/** Brand tokens come from BRAND (single source of truth); everything else lives in globals.css. */
const tokens = {
  '--night': BRAND.colors.night,
  '--gold': BRAND.colors.gold,
  '--lift': BRAND.colors.lift,
  '--font-ar': 'var(--nf-ar), ui-sans-serif, system-ui, sans-serif',
  '--font-sans': 'var(--nf-sans), ui-sans-serif, system-ui, sans-serif',
  '--font-mono': 'var(--nf-mono), ui-monospace, "SFMono-Regular", monospace',
} as CSSProperties;

/** `<html>` shell per locale (Arabic RTL default, English LTR). */
export function RootShell({ locale, children }: { locale: Locale; children: ReactNode }) {
  return (
    <html
      lang={locale}
      dir={locale === 'ar' ? 'rtl' : 'ltr'}
      style={tokens}
      className={`${geist.variable} ${geistMono.variable} ${plexArabic.variable}`}
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
