import type { CSSProperties, ReactNode } from 'react';
import { BRAND } from '@force/shared/brand';
import { type Locale } from '../lib/site';
import '@/app/globals.css';

/** Brand tokens come from BRAND (single source of truth); everything else lives in globals.css. */
const tokens = {
  '--night': BRAND.colors.night,
  '--gold': BRAND.colors.gold,
  '--lift': BRAND.colors.lift,
  '--font-ar': BRAND.fonts.stacks.arabic,
  '--font-sans': BRAND.fonts.stacks.sans,
  '--font-mono': BRAND.fonts.stacks.mono,
  backgroundColor: BRAND.colors.night,
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
            __html: `var l=document.createElement('link');l.rel='stylesheet';l.href=${JSON.stringify(BRAND.fonts.googleFontsUrl)};document.head.appendChild(l);`,
          }}
        />
        <noscript>
          <link rel="stylesheet" href={BRAND.fonts.googleFontsUrl} />
        </noscript>
      </head>
      <body>{children}</body>
    </html>
  );
}
