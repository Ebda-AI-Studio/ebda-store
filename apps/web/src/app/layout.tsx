import type { Metadata, Viewport } from 'next';
import { Suspense } from 'react';
import { Plus_Jakarta_Sans, IBM_Plex_Sans_Arabic } from 'next/font/google';
import { ToastProvider } from '@force/ui';
import { LanguageProvider } from '../contexts/LanguageContext';
import { StoreProvider } from '../contexts/StoreContext';
import { CartProvider } from '../contexts/CartContext';
import { AuthProvider } from '../contexts/AuthContext';
import { FeatureProvider } from '../contexts/FeatureContext';
import { getStore } from '../lib/store-resolver';
import { organizationJsonLd, getSiteUrl } from '../lib/structured-data';
import { MarketingPixelsProvider } from '../components/MarketingPixels';
import { ServiceWorkerRegistration } from '../components/ServiceWorkerRegistration';
import { PushNotificationPrompt } from '../components/PushNotificationPrompt';
import { AffiliateTracker } from '../components/AffiliateTracker';
import { type MarketingPixels, themeToCssVars } from '@force/shared';
import '../styles/globals.css';

/**
 * Sanitize a theme color value to prevent CSS injection.
 *
 * Theme colors from the database are HSL component strings (e.g. "26 100% 50%")
 * or hex colors (e.g. "#ff6e00"). This function validates the value matches one
 * of those safe formats and strips any dangerous CSS content that could escape
 * the declaration context.
 *
 * Returns `fallback` if the value does not pass validation.
 */
function sanitizeThemeColor(value: string, fallback = '0 0% 0%'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 50) {
    return fallback;
  }

  // Block dangerous CSS constructs that could break out of a declaration
  const dangerous = /[{}]|url\s*\(|@import|expression\s*\(|javascript\s*:/i;
  if (dangerous.test(value)) {
    return fallback;
  }

  // Hex color: #RGB, #RRGGBB, or #RRGGBBAA (3-8 hex digits)
  const hexPattern = /^#[0-9a-fA-F]{3,8}$/;
  if (hexPattern.test(value)) {
    return value;
  }

  // HSL components: e.g. "26 100% 50%", "0 0% 100%", "220 14% 96%"
  // Allows optional decimal points and the slash syntax for alpha (e.g. "26 100% 50% / 0.5")
  const hslPattern =
    /^[0-9]+(?:\.[0-9]+)?\s+[0-9]+(?:\.[0-9]+)?%\s+[0-9]+(?:\.[0-9]+)?%(?:\s*\/\s*[0-9]+(?:\.[0-9]+)?%?)?$/;
  if (hslPattern.test(value)) {
    return value;
  }

  return fallback;
}

/**
 * Sanitize a non-color CSS custom property value (e.g. --radius, --font-family).
 * Allows rem/px units, var() references, and simple keyword values.
 */
function sanitizeCssValue(value: string, fallback = '0'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) {
    return fallback;
  }
  const dangerous = /[{}]|url\s*\(|@import|expression\s*\(|javascript\s*:/i;
  if (dangerous.test(value)) {
    return fallback;
  }
  // Allow: digits, letters, spaces, %, #, dots, parens (for var()), slashes, hyphens, commas
  const allowed = /^[a-zA-Z0-9\s%#.,()\/\-]+$/;
  if (!allowed.test(value)) {
    return fallback;
  }
  return value;
}

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
  weight: ['400', '500', '600', '700', '800'],
});

const ibmPlexArabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic'],
  variable: '--font-arabic',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
});

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  themeColor: '#ff6e00',
};

export async function generateMetadata(): Promise<Metadata> {
  const store = await getStore();
  const siteUrl = getSiteUrl(store);
  const description =
    store.metaDescription || `Shop online at ${store.name}. Free delivery on orders over 20 KWD.`;

  return {
    metadataBase: new URL(siteUrl),
    title: {
      default: store.metaTitle || `${store.name} - Online Shopping in Kuwait`,
      template: `%s | ${store.name}`,
    },
    description,
    keywords: ['e-commerce', 'online store', 'shopping', 'Kuwait', 'KWD', 'delivery', store.name],
    authors: [{ name: store.name }],
    creator: store.name,
    publisher: store.name,
    formatDetection: {
      email: false,
      address: false,
      telephone: false,
    },
    openGraph: {
      type: 'website',
      locale: 'en_KW',
      alternateLocale: 'ar_KW',
      siteName: store.name,
      images: store.logo ? [{ url: store.logo }] : undefined,
    },
    twitter: {
      card: 'summary_large_image',
      title: store.metaTitle || `${store.name} - Online Shopping in Kuwait`,
      description,
      ...(store.logo ? { images: [store.logo] } : {}),
    },
    robots: {
      index: true,
      follow: true,
    },
    icons: store.favicon ? { icon: store.favicon } : undefined,
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Fetch store data server-side
  const store = await getStore();

  // Organization JSON-LD for search engines
  const orgJsonLd = organizationJsonLd(store);

  // Build a <style> tag that overrides the default orange theme in globals.css
  // Inline styles on <html> don't beat `:root {}` in @layer base, so we inject a :root rule instead
  const themeCssVars = store.theme ? themeToCssVars(store.theme) : null;
  // Non-color CSS custom properties that use sanitizeCssValue instead of sanitizeThemeColor
  const nonColorVars = new Set(['--radius', '--font-family']);

  const themeStyleTag = themeCssVars
    ? `:root { ${Object.entries(themeCssVars)
        .map(([k, v]) => {
          const sanitized = nonColorVars.has(k) ? sanitizeCssValue(v) : sanitizeThemeColor(v);
          return `${k}: ${sanitized}`;
        })
        .join('; ')} }`
    : '';

  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(orgJsonLd) }}
        />
        {themeStyleTag && <style dangerouslySetInnerHTML={{ __html: themeStyleTag }} />}
        {/* Detect system dark mode preference and apply .dark class before paint */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
                  document.documentElement.classList.add('dark');
                }
                window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
                  document.documentElement.classList.toggle('dark', e.matches);
                });
              } catch (e) {}
            `,
          }}
        />
        {/* Favicon is set via generateMetadata().icons -- no manual <link> needed */}
        {/* Manifest is generated by src/app/manifest.ts -- Next.js links it automatically */}
      </head>
      <body
        className={`${plusJakarta.variable} ${ibmPlexArabic.variable} font-sans antialiased bg-background text-foreground`}
      >
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[9999] focus:bg-white focus:text-black focus:px-4 focus:py-2 focus:rounded-lg focus:shadow-lg focus:text-sm focus:font-medium"
        >
          Skip to main content
        </a>
        <StoreProvider initialStore={store}>
          <FeatureProvider>
            <AuthProvider>
              <LanguageProvider
                defaultLanguage={
                  (store.settings as Record<string, unknown>)?.defaultLanguage as
                    | 'en'
                    | 'ar'
                    | undefined
                }
              >
                <CartProvider>
                  <ToastProvider>
                    <div id="main-content">{children}</div>
                  </ToastProvider>
                </CartProvider>
              </LanguageProvider>
            </AuthProvider>
            {store.marketingPixels && Object.keys(store.marketingPixels).length > 0 && (
              <MarketingPixelsProvider pixels={store.marketingPixels as MarketingPixels} />
            )}
            <ServiceWorkerRegistration />
            <PushNotificationPrompt />
            <Suspense fallback={null}>
              <AffiliateTracker />
            </Suspense>
          </FeatureProvider>
        </StoreProvider>
      </body>
    </html>
  );
}
