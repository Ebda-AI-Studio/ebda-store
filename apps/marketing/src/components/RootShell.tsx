import type { CSSProperties, ReactNode } from 'react';
import { BRAND } from '@force/shared/brand';
import { type Locale } from '../lib/site';
import { EbdaTracking } from './EbdaTracking';
import '@/app/globals.css';

/** BRAND's font URL plus IBM Plex Sans Arabic 700 for the Arabic display headlines. */
const FONTS_URL = BRAND.fonts.googleFontsUrl.replace(
  'IBM+Plex+Sans+Arabic:wght@400;500',
  'IBM+Plex+Sans+Arabic:wght@400;500;700'
);
// Fail the build loudly if BRAND's font URL changes shape and the 700 weight would silently vanish.
if (!FONTS_URL.includes('IBM+Plex+Sans+Arabic:wght@400;500;700')) {
  throw new Error(
    'RootShell: could not add IBM Plex Sans Arabic 700 to BRAND.fonts.googleFontsUrl'
  );
}

/** Brand tokens come from BRAND (single source of truth); everything else lives in globals.css. */
const tokens = {
  '--night': BRAND.colors.night,
  '--gold': BRAND.colors.gold,
  '--lift': BRAND.colors.lift,
  '--font-ar': BRAND.fonts.stacks.arabic,
  '--font-sans': BRAND.fonts.stacks.sans,
  '--font-mono': BRAND.fonts.stacks.mono,
} as CSSProperties;

/** `<html>` shell per locale (Arabic RTL default, English LTR). */
export function RootShell({ locale, children }: { locale: Locale; children: ReactNode }) {
  return (
    <html lang={locale} dir={locale === 'ar' ? 'rtl' : 'ltr'} style={tokens}>
      {/* eslint-disable-next-line @next/next/no-head-element -- app router: <head> in the root layout is the supported pattern */}
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* Fonts load non-blocking (swap): system fallbacks paint first. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `var l=document.createElement('link');l.rel='stylesheet';l.href=${JSON.stringify(FONTS_URL)};document.head.appendChild(l);`,
          }}
        />
        <noscript>
          <link rel="stylesheet" href={FONTS_URL} />
        </noscript>
      </head>
      <body>
        {children}
        <EbdaTracking />
      </body>
    </html>
  );
}
