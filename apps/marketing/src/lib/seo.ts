import type { Metadata } from 'next';
import { BRAND } from '@force/shared/brand';
import { COPY } from './content';
import { PLANS, PRICING_PUBLISHED } from './plans';
import {
  HOME,
  SIGNUP_URL,
  SITE_URL,
  absoluteUrl,
  pagePath,
  type Locale,
  type PageSlug,
} from './site';

type Page = PageSlug;

const OG_IMAGE = {
  url: '/og.png',
  width: 1200,
  height: 630,
  alt: 'ابدأ Ebda — بابك لبدء مشروعك. Your doorway to business.',
};

/** Metadata for a page in a locale, incl. canonical + hreflang alternates. */
export function pageMetadata(
  locale: Locale,
  page: Page,
  title?: string,
  description?: string
): Metadata {
  const c = COPY[locale];
  const t = title ?? c.meta.title;
  const d = description ?? c.meta.description;
  const languages: Record<string, string> = {
    ar: pagePath('ar', page),
    en: pagePath('en', page),
    'x-default': pagePath('ar', page),
  };
  return {
    metadataBase: new URL(SITE_URL),
    title: t,
    description: d,
    alternates: { canonical: pagePath(locale, page), languages },
    openGraph: {
      type: 'website',
      siteName: `${BRAND.product.nameEn} · ${BRAND.product.nameAr}`,
      title: t,
      description: d,
      url: pagePath(locale, page),
      locale: locale === 'ar' ? 'ar_EG' : 'en_US',
      alternateLocale: locale === 'ar' ? ['en_US'] : ['ar_EG'],
      images: [OG_IMAGE],
    },
    twitter: { card: 'summary_large_image', title: t, description: d, images: [OG_IMAGE.url] },
    icons: {
      icon: [
        { url: '/icon.svg', type: 'image/svg+xml' },
        { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      ],
      shortcut: '/favicon.ico',
      apple: '/apple-touch-icon.png',
    },
    robots: { index: true, follow: true },
  };
}

/** JSON-LD graph: Organization + WebSite + SoftwareApplication (offers from PLANS) + FAQPage (home). No ratings. */
export function jsonLd(locale: Locale) {
  const c = COPY[locale];
  const org = `${SITE_URL}/#organization`;
  const site = `${SITE_URL}/#website`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': org,
        name: BRAND.company.shortNameEn,
        alternateName: BRAND.company.shortNameAr,
        legalName: BRAND.company.legalNameEn,
        url: SITE_URL,
        logo: `${SITE_URL}/icon-512.png`,
        email: BRAND.supportEmail,
        sameAs: [] as string[],
      },
      {
        '@type': 'WebSite',
        '@id': site,
        url: absoluteUrl(HOME[locale]),
        name: BRAND.product.nameEn,
        inLanguage: locale,
        publisher: { '@id': org },
      },
      {
        '@type': 'SoftwareApplication',
        name: BRAND.product.nameEn,
        alternateName: BRAND.product.nameAr,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web',
        description: c.meta.description,
        url: SIGNUP_URL,
        installUrl: SIGNUP_URL,
        publisher: { '@id': org },
        inLanguage: ['ar', 'en'],
        ...(PRICING_PUBLISHED && {
          offers: PLANS.filter(p => p.price).map(p => ({
            '@type': 'Offer',
            name: p.name[locale],
            price: (p.price!.amountMinor / 100).toFixed(2),
            priceCurrency: 'EGP',
            priceSpecification: {
              '@type': 'UnitPriceSpecification',
              price: (p.price!.amountMinor / 100).toFixed(2),
              priceCurrency: 'EGP',
              billingDuration: 'P1M',
              unitCode: 'MON',
            },
            url: SIGNUP_URL,
            availability: 'https://schema.org/PreOrder',
          })),
        }),
      },
      ...(c.faq.items.length
        ? [
            {
              '@type': 'FAQPage',
              inLanguage: locale,
              mainEntity: c.faq.items.map(i => ({
                '@type': 'Question',
                name: i.q,
                acceptedAnswer: { '@type': 'Answer', text: i.a },
              })),
            },
          ]
        : []),
    ],
  };
}
