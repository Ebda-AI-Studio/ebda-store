import type { Metadata, Viewport } from 'next';
import { Plus_Jakarta_Sans, IBM_Plex_Sans_Arabic } from 'next/font/google';
import { ToastProvider } from '@force/ui';
import { LanguageProvider } from '../contexts/LanguageContext';
import { StoreProvider } from '../contexts/StoreContext';
import { CartProvider } from '../contexts/CartContext';
import { AuthProvider } from '../contexts/AuthContext';
import { getStore } from '../lib/store-resolver';
import { MarketingPixelsProvider } from '../components/MarketingPixels';
import { ServiceWorkerRegistration } from '../components/ServiceWorkerRegistration';
import type { MarketingPixels } from '@force/shared';
import '../styles/globals.css';

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

  return {
    title: {
      default: store.metaTitle || `${store.name} - Online Shopping in Kuwait`,
      template: `%s | ${store.name}`,
    },
    description:
      store.metaDescription || `Shop online at ${store.name}. Free delivery on orders over 20 KWD.`,
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

  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <head>
        {store.favicon && <link rel="icon" href={store.favicon} />}
        <link rel="manifest" href="/manifest.webmanifest" />
      </head>
      <body
        className={`${plusJakarta.variable} ${ibmPlexArabic.variable} font-sans antialiased bg-background text-foreground`}
      >
        <StoreProvider initialStore={store}>
          <AuthProvider>
            <LanguageProvider>
              <CartProvider>
                <ToastProvider>{children}</ToastProvider>
              </CartProvider>
            </LanguageProvider>
          </AuthProvider>
          {store.marketingPixels && Object.keys(store.marketingPixels).length > 0 && (
            <MarketingPixelsProvider pixels={store.marketingPixels as MarketingPixels} />
          )}
          <ServiceWorkerRegistration />
        </StoreProvider>
      </body>
    </html>
  );
}
