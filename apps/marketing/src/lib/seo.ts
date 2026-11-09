import type { Metadata } from 'next';
import {
  BRAND,
  WHATSAPP_PACKAGES,
  officePostalAddress,
  servicesJsonLd,
  type WhatsAppBasePackageId,
} from '@ebda/shared/brand';
import { CAPABILITIES } from './capabilities';
import { COPY } from './content';
import { PLANS, PRICING_PUBLISHED } from './plans';
import { WHATSAPP_APP_URL, WHATSAPP_PAGE } from './whatsapp-page';
import { STUDIO_HOME } from './studio-home';
import {
  HOME,
  STORE_HOME,
  SIGNUP_URL,
  SITE_URL,
  absoluteUrl,
  pagePath,
  productOfPage,
  type Locale,
  type PageSlug,
} from './site';

type Page = PageSlug;

const productLabel = (locale: Locale) =>
  locale === 'ar' ? BRAND.product.nameAr : BRAND.product.nameEn;
const productAlt = (locale: Locale) =>
  locale === 'ar' ? BRAND.product.nameEn : BRAND.product.nameAr;

/**
 * The one disambiguating brand line, in the OG description and the JSON-LD names (titles carry only the short tail): it keeps Ebda Store
 * (ebda.app, by Ebda AI Studio) from being confused with other "Ebda" sites. The product name leads
 * (ruling PRODUCT-NAME-1); the studio is named as the maker, never as the last word of a title.
 */
export const brandLine = () =>
  `${BRAND.product.nameEn} — ${BRAND.product.nameAr}, by ${BRAND.company.shortNameEn} (${BRAND.domains.marketing})`;

/** Short tail for inner-page titles (SERP titles stay under ~60 characters); the full line is on the home title, OG site data and JSON-LD. */
export const shortBrand = (locale: Locale) =>
  `${productLabel(locale)} (${BRAND.domains.marketing})`;

/** The Ebda Chat product page: its own name in the title tail, the OG site name, the brand line and the OG image. */
export type PageProduct = 'store' | 'whatsapp' | 'studio';
/** The title/OG product of a page, from its kind (NAV-PRODUCT-OF-PAGE-1): Store pages say Ebda Store, Chat pages Ebda Chat, every other page the studio. */
const pageProduct = (page: string): PageProduct => {
  const kind = productOfPage(page);
  return kind === 'chat' ? 'whatsapp' : kind;
};
const WA_OG_IMAGE = {
  url: '/og-whatsapp.png',
  width: 1200,
  height: 630,
  alt: `${BRAND.productWhatsapp.nameAr} · ${BRAND.productWhatsapp.nameEn} · ${BRAND.domains.marketing}`,
};
const waLabel = (locale: Locale) =>
  locale === 'ar' ? BRAND.productWhatsapp.nameAr : BRAND.productWhatsapp.nameEn;
export const whatsappBrandLine = () =>
  `${BRAND.productWhatsapp.nameEn} — ${BRAND.productWhatsapp.nameAr}, by ${BRAND.company.shortNameEn} (${BRAND.domains.marketing})`;
const LANTERN_POSTER = {
  url: '/ads/lantern-poster.png',
  width: 1200,
  height: 630,
  alt: 'فانوس نحاس مضيء، وجملة «شوف منتجك من كل زاوية قبل ما يشتريه.»',
};
const LANTERN_VIDEO = {
  url: '/ads/lantern-1080x1350.mp4',
  width: 1080,
  height: 1350,
  type: 'video/mp4',
};

const OG_IMAGE = {
  url: '/og.png',
  width: 1200,
  height: 630,
  // Describes what og.png shows (the wordmark, «ابدأ متجرك» and the domain), nothing else.
  alt: `${BRAND.product.nameAr} — ابدأ متجرك · ${BRAND.domains.marketing}`,
};

/** Metadata for a page in a locale, incl. canonical + hreflang alternates. */
export function pageMetadata(
  locale: Locale,
  page: Page,
  title?: string,
  description?: string,
  product: PageProduct = pageProduct(page)
): Metadata {
  const c = COPY[locale];
  const wa = product === 'whatsapp';
  const studio = product === 'studio';
  // Titles, OG and Twitter name the PRODUCT (ruling PRODUCT-NAME-1); the studio is only the
  // publisher / organization (see jsonLd).
  const name = wa
    ? waLabel(locale)
    : studio
      ? locale === 'ar'
        ? BRAND.company.shortNameAr
        : BRAND.company.shortNameEn
      : productLabel(locale);
  // Home: the product title as written. Other pages: page title, then the short brand tail. A title that already
  // names the product (the about page) is not repeated.
  const lead = (title ?? c.meta.title).replace(new RegExp(`^${name} — `), '');
  const tail = wa || studio ? `${name} (${BRAND.domains.marketing})` : shortBrand(locale);
  // the studio home carries its own full title; a studio inner page ends in the studio name unless its title already says it
  const t =
    studio && page === '' && title
      ? title
      : studio && title
        ? lead.includes(name)
          ? `${lead} (${BRAND.domains.marketing})`
          : `${lead} | ${tail}`
        : title
          ? `${lead} | ${tail}`
          : c.meta.title;
  const d = description ?? c.meta.description;
  // The five /for/<vertical>/ pages carry their own card (scripts/make-og-verticals.mjs); everything else the shared one.
  const vertical = page.match(/^for\/(fashion|electronics|beauty|food|jewellery)$/)?.[1];
  const ogImage = vertical
    ? { ...OG_IMAGE, url: `/og/${vertical}.png`, alt: `${t} · ${BRAND.domains.marketing}` }
    : OG_IMAGE;
  const lanternAd = vertical === 'electronics';
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
      // the full disambiguating line rides in the OG description (and the JSON-LD), not in every title
      description: studio ? d : `${d} ${wa ? whatsappBrandLine() : brandLine()}.`,
      url: pagePath(locale, page),
      locale: locale === 'ar' ? 'ar_EG' : 'en_US',
      alternateLocale: locale === 'ar' ? ['en_US'] : ['ar_EG'],
      // The WhatsApp page keeps its own card.
      images: wa ? [WA_OG_IMAGE] : lanternAd ? [LANTERN_POSTER, ogImage] : [ogImage],
      ...(!wa && lanternAd ? { videos: [LANTERN_VIDEO] } : {}),
    },
    twitter: {
      card: 'summary_large_image',
      title: t,
      description: d,
      images: [wa ? WA_OG_IMAGE.url : lanternAd ? LANTERN_POSTER.url : ogImage.url],
    },
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
  const brand = `${SITE_URL}/#store`;
  // the studio home owns #website (studioJsonLd); this is the Ebda Store site, so it gets its own id
  const site = `${SITE_URL}/#website-store`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': org,
        name: BRAND.company.shortNameEn,
        alternateName: BRAND.company.shortNameAr,
        url: SITE_URL,
        logo: `${SITE_URL}/icon-512.png`,
        address: officePostalAddress(),
        ...servicesJsonLd(locale),
        legalName: locale === 'ar' ? BRAND.company.legalNameAr : BRAND.company.legalNameEn,
        foundingDate: BRAND.company.foundedOn,
        email: BRAND.supportEmail,
      },
      {
        // The product as a brand: "Ebda Store" (ابدأ ستور), made by the studio above.
        '@type': 'Organization',
        '@id': brand,
        name: BRAND.product.nameEn,
        alternateName: [BRAND.product.nameAr, brandLine()],
        url: absoluteUrl(STORE_HOME[locale]),
        logo: `${SITE_URL}/logo-store.png`,
        email: BRAND.supportEmail,
        parentOrganization: { '@id': org },
      },
      {
        '@type': 'WebSite',
        '@id': site,
        url: absoluteUrl(STORE_HOME[locale]),
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

/**
 * JSON-LD of the Ebda AI Studio home (Ruling MKT-HOME-1): the studio is the Organization and the WebSite; each product is
 * its own entity under it (the same ids as on the product pages).
 */
export function studioJsonLd(locale: Locale) {
  const org = `${SITE_URL}/#organization`;
  const c = STUDIO_HOME[locale];
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': org,
        name: BRAND.company.shortNameEn,
        alternateName: BRAND.company.shortNameAr,
        url: SITE_URL,
        logo: `${SITE_URL}/icon-512.png`,
        address: officePostalAddress(),
        ...servicesJsonLd(locale),
        legalName: locale === 'ar' ? BRAND.company.legalNameAr : BRAND.company.legalNameEn,
        foundingDate: BRAND.company.foundedOn,
        email: BRAND.supportEmail,
      },
      {
        '@type': 'WebSite',
        '@id': `${SITE_URL}/#website`,
        url: absoluteUrl(HOME[locale]),
        name: BRAND.company.shortNameEn,
        alternateName: BRAND.company.shortNameAr,
        description: c.meta.desc,
        inLanguage: locale,
        publisher: { '@id': org },
      },
      {
        '@type': 'Organization',
        '@id': `${SITE_URL}/#store`,
        name: BRAND.product.nameEn,
        alternateName: [BRAND.product.nameAr, brandLine()],
        url: absoluteUrl(STORE_HOME[locale]),
        parentOrganization: { '@id': org },
      },
      {
        '@type': 'Organization',
        '@id': `${SITE_URL}/#whatsapp`,
        name: BRAND.productWhatsapp.nameEn,
        alternateName: [BRAND.productWhatsapp.nameAr, whatsappBrandLine()],
        url: absoluteUrl(pagePath(locale, 'whatsapp')),
        parentOrganization: { '@id': org },
      },
    ],
  };
}

/**
 * JSON-LD of the Ebda Chat page: the studio (publisher), the product as a brand under it, a SoftwareApplication
 * and the page FAQ. Offers come from WHATSAPP_PACKAGES (WA-PRICE-1), the same constant the pricing section renders.
 */
export function whatsappJsonLd(locale: Locale, faq: readonly { q: string; a: string }[]) {
  const org = `${SITE_URL}/#organization`;
  const brand = `${SITE_URL}/#whatsapp`;
  const p = WHATSAPP_PAGE[locale];
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': org,
        name: BRAND.company.shortNameEn,
        alternateName: BRAND.company.shortNameAr,
        url: SITE_URL,
        logo: `${SITE_URL}/icon-512.png`,
        address: officePostalAddress(),
        ...servicesJsonLd(locale),
        legalName: locale === 'ar' ? BRAND.company.legalNameAr : BRAND.company.legalNameEn,
        foundingDate: BRAND.company.foundedOn,
        email: BRAND.supportEmail,
      },
      {
        '@type': 'Organization',
        '@id': brand,
        name: BRAND.productWhatsapp.nameEn,
        alternateName: [BRAND.productWhatsapp.nameAr, whatsappBrandLine()],
        url: absoluteUrl(pagePath(locale, 'whatsapp')),
        parentOrganization: { '@id': org },
      },
      {
        '@type': 'SoftwareApplication',
        name: waLabel(locale),
        alternateName:
          locale === 'ar' ? BRAND.productWhatsapp.nameEn : BRAND.productWhatsapp.nameAr,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web',
        description: p.meta.desc,
        brand: { '@id': brand },
        featureList: p.features.map(f => f.t),
        url: WHATSAPP_APP_URL,
        installUrl: WHATSAPP_APP_URL,
        publisher: { '@id': org },
        inLanguage: ['ar', 'en'],
        // one Offer per PRICED package id in WHATSAPP_PACKAGES (WA-PRICE-1; store-included has no price, there is no free plan): EGP for the package's period (1 or 12 months), Meta fees excluded
        offers: WHATSAPP_PACKAGES.filter(pk => pk.priceMinor > 0).map(pk => {
          const yearly = pk.periodMonths === 12;
          const price = (pk.priceMinor / 100).toFixed(2);
          const base = pk.id.replace(/-yearly$/, '') as WhatsAppBasePackageId;
          return {
            '@type': 'Offer',
            name: `${p.pricing.names[base].name} (${yearly ? p.pricing.yearly : p.pricing.monthly})`,
            sku: pk.id,
            price,
            priceCurrency: 'EGP',
            priceSpecification: {
              '@type': 'UnitPriceSpecification',
              price,
              priceCurrency: 'EGP',
              billingDuration: yearly ? 'P1Y' : 'P1M',
              unitCode: yearly ? 'ANN' : 'MON',
            },
            url: WHATSAPP_APP_URL,
            availability: 'https://schema.org/PreOrder',
          };
        }),
      },
      {
        '@type': 'FAQPage',
        inLanguage: locale,
        mainEntity: faq.map(i => ({
          '@type': 'Question',
          name: i.q,
          acceptedAnswer: { '@type': 'Answer', text: i.a },
        })),
      },
    ],
  };
}
