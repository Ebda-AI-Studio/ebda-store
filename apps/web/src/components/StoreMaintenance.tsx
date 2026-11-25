'use client';

import Image from 'next/image';
import { useStore } from '../contexts/StoreContext';
import { useLanguage } from '../contexts/LanguageContext';
import { BRAND, referralUrl } from '@ebda/shared';

import { normalizeEgyptianMobile } from '@ebda/shared';
/**
 * Branded "we'll be back soon" page rendered when the resolved store has
 * `status === 'suspended'`. Replaces the normal storefront chrome on every
 * route so the customer feels like the merchant — not Ebda — is in
 * maintenance.
 *
 * Wired in via `StoreMaintenanceGate` (used in `app/layout.tsx`) so every
 * page (`/`, `/products`, `/cart`, `/checkout`, ...) flips to this screen
 * automatically — there is no per-route opt-in.
 *
 * Visual choices:
 *   - Picks `logoAr` when locale is Arabic and present, falls back to the
 *     English logo, then to a text mark of the store name. The store's
 *     theme already drives the page's CSS variables (background, primary,
 *     foreground) via the layout's :root style tag, so colors come for
 *     free.
 *   - Decorative blurred SVG blobs use the primary + accent colors at low
 *     opacity. They sit behind the content and are hidden from screen
 *     readers (`aria-hidden="true"`).
 *   - The contact strip only renders when at least one contact channel is
 *     set — empty stores get the headline + body alone, which still reads
 *     intentional rather than half-finished.
 *   - "Powered by Ebda" footer link points to the marketing site so any
 *     customer who lands here can verify the platform is healthy even when
 *     this particular store is offline.
 *
 * SEO: the layout's metadata includes `robots: { index: true, follow: true }`
 * by default; we override with a `<meta name="robots" content="noindex">`
 * so search engines don't index a maintenance page as the store's
 * canonical content.
 */
export function StoreMaintenance() {
  const { store } = useStore();
  const { language, t, isRtl } = useLanguage();

  const localizedName = isRtl && store.nameAr ? store.nameAr : store.name;
  const logoSrc = isRtl && store.logoAr ? store.logoAr : store.logo;

  const headline = t('This store is temporarily unavailable', 'المتجر غير متاح مؤقتًا');
  const bodyTail = t(
    'is not taking orders right now. Please check back later.',
    'مش بيستقبل طلبات دلوقتي. جرّب تاني بعدين.'
  );
  const contactHeading = t('Need to reach us?', 'تحتاج للتواصل معنا؟');
  const poweredByLabel = t(
    `Powered by ${BRAND.product.nameEn}`,
    `مدعوم من ${BRAND.product.nameAr}`
  );

  // Normalize the WhatsApp number to digits so wa.me works regardless of the
  // format the merchant typed (the admin form accepts "+20 101 234 5678",
  // "01012345678", "0020 1012345678", etc.). An Egyptian mobile is promoted to
  // its international form (wa.me needs the country code); anything else keeps
  // just its digits.
  const whatsappDigits = store.whatsapp
    ? (normalizeEgyptianMobile(store.whatsapp)?.slice(1) ?? store.whatsapp.replace(/\D/g, ''))
    : '';
  const hasContact = !!(store.email || store.phone || whatsappDigits);

  return (
    <>
      {/* No in-body robots <meta>: under React 18 it stays in <body>, where
          crawlers ignore it. The real noindex is in <head>:
          buildStorefrontMetadata sets robots noindex for a suspended store
          (lib/storefront-metadata.ts), via app/layout.tsx::generateMetadata. */}
      <div
        lang={language}
        dir={isRtl ? 'rtl' : 'ltr'}
        className="relative isolate flex min-h-screen flex-col items-center justify-between overflow-hidden bg-background px-6 py-32 text-foreground sm:py-48"
      >
        {/* Decorative background blobs — primary and accent colors at low
            opacity, blurred so they read as soft brand wash rather than
            shapes. Hidden from screen readers and pointer events. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
        >
          <div
            className="absolute -top-40 left-1/2 h-[36rem] w-[36rem] -translate-x-1/2 rounded-full opacity-20 blur-3xl"
            style={{ backgroundColor: 'hsl(var(--primary))' }}
          />
          <div
            className="absolute bottom-[-12rem] right-[-8rem] h-[28rem] w-[28rem] rounded-full opacity-15 blur-3xl"
            style={{ backgroundColor: 'hsl(var(--accent))' }}
          />
          <div
            className="absolute left-[-6rem] top-1/3 h-[20rem] w-[20rem] rounded-full opacity-10 blur-3xl"
            style={{ backgroundColor: 'hsl(var(--primary))' }}
          />
        </div>

        <main className="flex w-full max-w-3xl flex-1 flex-col items-center justify-center text-center">
          {/* Logo or text mark. Next/Image with `unoptimized` so SVG logos
              and R2-hosted PNGs both render without surprises. */}
          {logoSrc ? (
            <div className="mb-10 flex items-center justify-center">
              <Image
                src={logoSrc}
                alt={localizedName}
                width={256}
                height={128}
                priority
                unoptimized
                className="h-32 w-auto object-contain sm:h-40"
              />
            </div>
          ) : (
            <div
              className="mb-10 text-4xl font-bold tracking-tight sm:text-5xl"
              style={{ color: 'hsl(var(--primary))' }}
            >
              {localizedName}
            </div>
          )}

          <h1
            aria-live="polite"
            className="mb-6 text-balance text-4xl font-bold tracking-tight sm:text-5xl"
          >
            {headline}
          </h1>

          <p className="max-w-xl text-balance text-lg text-muted-foreground sm:text-xl">
            <span className="font-semibold text-foreground">{localizedName}</span> {bodyTail}
          </p>

          {hasContact && (
            <section className="mt-12 w-full max-w-md rounded-2xl border border-border bg-card/60 p-6 text-card-foreground shadow-sm backdrop-blur">
              <h2 className="mb-4 text-base font-semibold">{contactHeading}</h2>
              <ul className="flex flex-col gap-3 text-sm">
                {store.email && (
                  <li>
                    <a
                      href={`mailto:${store.email}`}
                      className="inline-flex items-center gap-2 text-foreground transition-colors hover:text-[hsl(var(--primary))]"
                    >
                      <span aria-hidden="true">✉</span>
                      <span className="break-all">{store.email}</span>
                    </a>
                  </li>
                )}
                {store.phone && (
                  <li>
                    <a
                      href={`tel:${store.phone.replace(/\s+/g, '')}`}
                      className="inline-flex items-center gap-2 text-foreground transition-colors hover:text-[hsl(var(--primary))]"
                      dir="ltr"
                    >
                      <span aria-hidden="true">☎</span>
                      <span>{isRtl && store.phoneAr ? store.phoneAr : store.phone}</span>
                    </a>
                  </li>
                )}
                {whatsappDigits && (
                  <li>
                    <a
                      href={`https://wa.me/${whatsappDigits}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 text-foreground transition-colors hover:text-[hsl(var(--primary))]"
                      dir="ltr"
                    >
                      <span aria-hidden="true">⌬</span>
                      <span>WhatsApp</span>
                    </a>
                  </li>
                )}
              </ul>
            </section>
          )}
        </main>

        <footer className="mt-16 text-xs text-muted-foreground">
          <a
            href={referralUrl('badge')}
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-foreground"
          >
            {poweredByLabel}
          </a>
        </footer>
      </div>
    </>
  );
}

/**
 * Wrap the storefront in this gate at the layout level. When the resolved
 * store is suspended we render the branded maintenance page and skip the
 * normal chrome / children entirely; otherwise we just render `children`.
 *
 * Server-component-friendly: the gate itself is a server component that
 * decides which subtree to render based on the (server-fetched) store
 * status, and the actual maintenance UI is the client `StoreMaintenance`.
 */
export function StoreMaintenanceGate({
  isSuspended,
  children,
}: {
  isSuspended: boolean;
  children: React.ReactNode;
}) {
  if (isSuspended) {
    return <StoreMaintenance />;
  }
  return <>{children}</>;
}
