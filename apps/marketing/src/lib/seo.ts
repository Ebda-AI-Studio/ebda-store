import type { Metadata } from 'next';
import { BRAND } from '@ebda/shared/brand';
import { CAPABILITIES } from './capabilities';
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

const productLabel = (locale: Locale) =>
  locale === 'ar' ? BRAND.product.nameAr : BRAND.product.nameEn;
const productAlt = (locale: Locale) =>
  locale === 'ar' ? BRAND.product.nameEn : BRAND.product.nameAr;

/**
 * The one disambiguating brand line, on every title, and in the JSON-LD names: it keeps Ebda Store
 * (ebda.app, by Ebda AI Studio) from being confused with other "Ebda" sites. The product name leads
 * (ruling PRODUCT-NAME-1); the studio is named as the maker, never as the last word of a title.
 */
export const brandLine = () =>
  `${BRAND.product.nameEn} — ${BRAND.product.nameAr}, by ${BRAND.company.shortNameEn} (${BRAND.domains.marketing})`;

const OG_IMAGE = {
  url: '/og.png',
  width: 1200,
  height: 630,
  // Describes what og.png shows (the wordmark, «ابدأ متجرك» and the domain), nothing else.
  alt: `ebda ابدأ — ابدأ متجرك · ${BRAND.domains.marketing}`,
};

/** Metadata for a page in a locale, incl. canonical + hreflang alternates. */
export function pageMetadata(
  locale: Locale,
  page: Page,
  title?: string,
  description?: string
): Metadata {
  const c = COPY[locale];
  // Titles, OG and Twitter name the PRODUCT (ruling PRODUCT-NAME-1); the studio is only the
  // publisher / organization (see jsonLd).
  const name = productLabel(locale);
  // Home: brand line first, then the tagline. Other pages: page title first. A title that already
  // names the product (the about page) is not repeated.
  const lead = (title ?? c.meta.title).replace(new RegExp(`^${name} — `), '');
  const t = title ? `${lead} | ${brandLine()}` : `${brandLine()} | ${lead}`;
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
      siteName: name,
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

/**
 * JSON-LD graph: Organization (the studio, the publisher) + WebSite and SoftwareApplication (both name the
 * product, «ابدأ ستور» / Ebda Store) + FAQPage (home). Offers come from PLANS. No ratings.
 */
export function jsonLd(
  locale: Locale,
  faq: readonly { q: string; a: string }[] = COPY[locale].faq.items
) {
  const c = COPY[locale];
  const org = `${SITE_URL}/#organization`;
  const brand = `${SITE_URL}/#brand`;
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
        // No verified public profiles yet; add real ones only (never a guessed handle).
        sameAs: [] as string[],
      },
      {
        // The product as a brand: "Ebda Store" (ابدأ ستور), made by the studio above.
        '@type': 'Organization',
        '@id': brand,
        name: BRAND.product.nameEn,
        alternateName: [BRAND.product.nameAr, brandLine()],
        url: SITE_URL,
        logo: `${SITE_URL}/icon-512.png`,
        email: BRAND.supportEmail,
        parentOrganization: { '@id': org },
        sameAs: [] as string[],
      },
      {
        '@type': 'WebSite',
        '@id': site,
        url: absoluteUrl(HOME[locale]),
        name: productLabel(locale),
        alternateName: productAlt(locale),
        inLanguage: locale,
        publisher: { '@id': org },
        about: { '@id': brand },
      },
      {
        '@type': 'SoftwareApplication',
        name: productLabel(locale),
        alternateName: productAlt(locale),
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web',
        description: c.meta.description,
        brand: { '@id': brand },
        featureList: Object.values(CAPABILITIES[locale]).map(x => x.t),
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
      ...(faq.length
        ? [
            {
              '@type': 'FAQPage',
              inLanguage: locale,
              mainEntity: faq.map(i => ({
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
