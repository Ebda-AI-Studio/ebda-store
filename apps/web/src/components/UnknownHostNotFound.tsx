'use client';

import { BRAND } from '@ebda/shared';
import { useLanguage } from '../contexts/LanguageContext';
import type { UnknownHostLinks } from '../lib/unknown-store-page';

/**
 * Generic Ebda 404 for a host that is not a live store (Ruling SUBDOMAIN-404-1):
 * an unknown or inactive `<slug>.ebda.app`, an unenrolled custom domain, or an
 * unknown path on the bare platform host. HTTP 404, no redirect (a redirect on
 * a dead URL is a soft-404). A live store's own 404 never reaches this; see
 * `app/not-found.tsx` and `StoreNotFound`.
 *
 * Colours/fonts come from BRAND (the marketing site's quiet light canvas with
 * the gold as the single accent); nothing here reads a store theme, because
 * there is no store. Arabic-first: the root layout defaults the document to
 * Arabic and `t(en, ar)` follows the visitor's language cookie.
 */
const INK = '#121314';
const MUTED = '#575c5d';
const LINE = '#868b8c';

export function UnknownHostNotFound({ links }: { links: UnknownHostLinks }) {
  const { t, isRtl } = useLanguage();
  const font = isRtl ? BRAND.fonts.stacks.arabic : BRAND.fonts.stacks.sans;
  const button =
    'inline-flex min-h-12 w-full items-center justify-center rounded-xl px-6 text-[15px] font-semibold transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 sm:w-auto';

  return (
    <main
      className="flex min-h-screen flex-col items-center justify-center px-6 py-16 text-center"
      style={{ background: '#fafafa', color: INK, fontFamily: font }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/favicon.svg"
        width={64}
        height={64}
        alt={isRtl ? BRAND.product.nameAr : BRAND.product.nameEn}
      />

      <h1 className="mt-8 max-w-md text-balance text-2xl font-bold leading-snug sm:text-3xl">
        {t('This store doesn’t exist or hasn’t opened yet', 'المتجر ده مش موجود أو لسه مفتحش')}
      </h1>
      <p className="mt-3 max-w-sm text-[15px] leading-relaxed" style={{ color: MUTED }}>
        {t(
          'Check the link, or start your own store on Ebda Store in minutes.',
          'اتأكد من الرابط، أو ابدأ متجرك الخاص على ابدأ ستور في دقايق.'
        )}
      </p>

      <div className="mt-8 flex w-full max-w-sm flex-col items-stretch gap-3 sm:max-w-none sm:flex-row sm:justify-center">
        <a
          href={links.createStoreUrl}
          className={button}
          style={{ background: BRAND.colors.gold, color: BRAND.colors.night, outlineColor: INK }}
        >
          {t('Create your store on Ebda Store', 'أنشئ متجرك على ابدأ ستور')}
        </a>
        {links.whatsappHref && (
          <a
            href={links.whatsappHref}
            target="_blank"
            rel="noopener noreferrer"
            className={`${button} border`}
            style={{ borderColor: LINE, color: INK, outlineColor: INK }}
          >
            {t('Chat with us on WhatsApp', 'تواصل معنا عبر واتساب')}
          </a>
        )}
      </div>

      {links.demoStoreHref && (
        <a
          href={links.demoStoreHref}
          className="mt-6 text-sm font-medium underline underline-offset-4"
          style={{ color: INK }}
        >
          {t('Try the demo store', 'جرّب المتجر التجريبي')}
        </a>
      )}
    </main>
  );
}
