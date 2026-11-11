import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { IBM_Plex_Sans_Arabic } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { Providers } from './providers';
import { intlFormats } from '../i18n/formats';
import '../styles/globals.css';
import { brandTagline } from '@ebda/shared';
import { productName } from '../lib/product-name';
import { THEME_INIT_SCRIPT } from '@/lib/auth-theme';

// DS-FONT-1: ONE family for every Ebda surface, Arabic and Latin from the same face (no Geist: a second Latin set
// beside Arabic text mismatched x-height and digits).
const ibmPlexArabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic', 'latin'],
  variable: '--font-sans',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
});

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const name = productName(locale);
  return {
    title: {
      default: name,
      template: `%s · ${name}`,
    },
    description: brandTagline(locale),
    // Tell every crawler to skip this domain entirely. Belt-and-suspenders
    // with `apps/admin/public/robots.txt` and the X-Robots-Tag header in
    // next.config.js — any one of these layers is enough but Google
    // sometimes ignores robots.txt for already-discovered URLs while
    // honouring the meta tag, and vice-versa.
    robots: {
      index: false,
      follow: false,
      nocache: true,
      googleBot: {
        index: false,
        follow: false,
        noimageindex: true,
        'max-snippet': -1,
        'max-image-preview': 'none',
        'max-video-preview': -1,
      },
    },
    // PWA install metadata. apple-* keys exist because iOS Safari requires
    // an installed PWA before granting Web Push permission, and the install
    // prompt picks up these tags rather than the manifest.
    applicationName: name,
    appleWebApp: {
      capable: true,
      title: name,
      statusBarStyle: 'default',
    },
    formatDetection: {
      telephone: false,
    },
    icons: {
      icon: [
        { url: '/favicon.svg', type: 'image/svg+xml' },
        { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
        { url: '/favicon-16.png', sizes: '16x16', type: 'image/png' },
      ],
      apple: '/apple-touch-icon.png',
    },
  };
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  // viewport-fit=cover lets the page extend into the iPhone safe-area
  // (notch / home indicator regions) so the fixed mobile bottom-nav can
  // sit flush with the screen edge while still padding itself with
  // env(safe-area-inset-bottom). Without this iOS treats the safe-area
  // env vars as 0 and the nav bar overlaps the home indicator.
  viewportFit: 'cover' as const,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const t = await getTranslations('common');
  // The per-request CSP nonce set by middleware.ts: script-src accepts only nonced scripts (SEC-4).
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    // globals.css turns on `scroll-behavior: smooth` for html; Next only switches it off while it resets
    // the scroll after a navigation when this attribute is present (without it a page can open scrolled down).
    <html lang={locale} dir={dir} data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        {/* Inline script to prevent flash of wrong theme on page load.
            Only reads from localStorage — no user input, safe static content.
            The signed-out pages stay light (lib/auth-theme.ts). */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: THEME_INIT_SCRIPT,
          }}
        />
      </head>
      <body className={`${ibmPlexArabic.variable} font-sans antialiased`}>
        <a
          href="#admin-main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:start-4 focus:z-[9999] focus:rounded-lg focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {t('skipToMainContent')}
        </a>
        <NextIntlClientProvider locale={locale} messages={messages} formats={intlFormats}>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
