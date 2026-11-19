import type { Metadata } from 'next';
import {
  BRAND,
  SOCIAL_SAME_AS,
  WHATSAPP_PACKAGES,
  officePostalAddress,
  servicesJsonLd,
  type WhatsAppBasePackageId,
} from '@ebda/shared/brand';
import { CAPABILITIES } from './capabilities';
import { COPY } from './content';
import { PLANS, PRICING_PUBLISHED } from './plans';

/**
 * The studio's founder, Ahmad Sharaf, under the same Person @id mypovonai.com and whisky11.com publish, so the three
 * sites' entity graphs join for answer engines (Ahmad, 2026-11-11). Identity only: no role claims beyond founder. Not on
 * the legal pages (operator without a personal name). Declared once, on the studio home (studioJsonLd), where the
 * Organization is described in full; the other graphs reference the same @id (and stay inside their HTML budgets).
 */
export const FOUNDER = {
  '@type': 'Person',
  '@id': 'https://mypovonai.com/#person',
  name: 'Ahmad Sharaf',
  // mypovonai.com only: no customer-facing ebda.app surface links whisky11.com (marketing-site.test "marketing honesty");
  // the shared @id already joins this node to the whisky11.com graph.
  sameAs: ['https://mypovonai.com'],
} as const;
import { WHATSAPP_APP_URL, WHATSAPP_PAGE } from './whatsapp-page';
import { STUDIO_HOME } from './studio-home';
import { SERVICE_LINE_CONTENT, type LineId } from './service-lines-content';
import { serviceLinesMode, serviceLinesPublished } from './service-lines';
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

/**
 * `knowsAbout` / `makesOffer` of the Organization node: the core (BRAND.services), plus the three service lines ONLY when they are
 * published (SERVICES-IA-1: nothing about them leaks before the go).
 */
function orgServices(locale: Locale) {
  const core = servicesJsonLd(locale);
  if (!serviceLinesPublished()) return core;
  const lines = BRAND.serviceLines.map(l => (locale === 'ar' ? l.nameAr : l.nameEn));
  return {
    knowsAbout: [...core.knowsAbout, ...lines],
    makesOffer: [
      ...core.makesOffer,
      ...BRAND.serviceLines.map(l => ({
        '@type': 'Offer',
        itemOffered: {
          '@type': 'Service',
          name: locale === 'ar' ? l.nameAr : l.nameEn,
          description: SERVICE_LINE_CONTENT[l.id as LineId][locale].tagline,
          url: absoluteUrl(pagePath(locale, `services/${l.id}` as PageSlug)),
        },
      })),
    ],
  };
}

/** One service-line page (published only): the Service under the studio Organization, and the page FAQ. */
export function serviceLineJsonLd(locale: Locale, id: LineId) {
  const c = SERVICE_LINE_CONTENT[id][locale];
  const line = BRAND.serviceLines.find(l => l.id === id)!;
  const org = `${SITE_URL}/#organization`;
  const url = absoluteUrl(pagePath(locale, `services/${id}` as PageSlug));
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Service',
        '@id': `${url}#service`,
        name: locale === 'ar' ? line.nameAr : line.nameEn,
        description: c.hero.lead,
        url,
        inLanguage: locale,
        areaServed: { '@type': 'Country', name: 'Egypt' },
        provider: { '@id': org },
        serviceType: c.tagline,
      },
      {
        '@type': 'FAQPage',
        inLanguage: locale,
        mainEntity: c.faq.map(i => ({
          '@type': 'Question',
          name: i.q,
          acceptedAnswer: { '@type': 'Answer', text: i.a },
        })),
      },
    ],
  };
}

/**
 * A meta description cut from longer text (the legal pages use their first paragraph): at most `max` characters, cut at a
 * word boundary and ended with "…", never mid-word (content audit C16; was `.slice(0, 160)`).
 */
export function snippet(text: string, max = 160): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const end = cut.lastIndexOf(' ');
  return `${cut.slice(0, end > 0 ? end : cut.length).replace(/[\s,،؛;:(«"'—-]+$/u, '')}…`;
}

/** Meta title/description of the Services index and the line pages (descriptions 100-160 characters). */
export const SERVICES_META = {
  ar: {
    marketing: {
      title: 'التسويق والإعلان وإنتاج المحتوى',
      desc: 'خدمة تسويق وإعلان وإنتاج محتوى من ابدأ ستوديو للذكاء الاصطناعي: خطة بهدف واضح، محتوى وإعلانات، ورد على كل عميل على واتساب، وتقرير بالأرقام.',
    },
    design: {
      title: 'التصميم والتنفيذ للبيوت',
      desc: 'تصميم داخلي وخارجي وديكور وتنفيذ كامل من ابدأ ستوديو للذكاء الاصطناعي: تشوف بيتك صورة واقعية وتكلفته بالجنيه قبل ما يتنفذ، وتتابع على واتساب.',
    },
    events: {
      title: 'تنظيم الفعاليات',
      desc: 'تنظيم فعاليات الشركات والمؤتمرات والمعارض وإطلاق المنتجات من ابدأ ستوديو للذكاء الاصطناعي: دعوات على واتساب وتسجيل بالـ QR وخطة وميزانية ومتابعة بعد الفعالية.',
    },
  },
  en: {
    marketing: {
      title: 'Marketing, advertising and content',
      desc: 'Marketing, advertising and content production from Ebda AI Studio: a plan with a clear goal, content, ads, every customer answered on WhatsApp, clear numbers.',
    },
    design: {
      title: 'Home design and build',
      desc: 'Interior and exterior design, decor and full execution from Ebda AI Studio: see your home as a realistic image with an early cost in EGP before it is built.',
    },
    events: {
      title: 'Event organising',
      desc: 'Corporate events, conferences, exhibitions and launches organised by Ebda AI Studio: WhatsApp invitations, QR check-in, a clear plan and budget, and follow-up.',
    },
  },
} as const;

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
  // ONE title pattern (content audit C13, Ruling MKT-TITLE-1); every title ends in "(ebda.app)":
  //  - a home page (the studio home, or a page with no title of its own: /store): its own full title + " (ebda.app)";
  //  - an inner page: "<page> | <product of the page> (ebda.app)" (Ebda Store / Ebda Chat / Ebda AI Studio); a leading
  //    "<product> — " or "<product>: " is dropped from <page> so the product is not said twice;
  //  - a studio page whose title already names the studio (About, Contact): "<page> (ebda.app)".
  const domain = `(${BRAND.domains.marketing})`;
  const withDomain = (s: string) => (s.endsWith(domain) ? s : `${s} ${domain}`);
  const lead = (title ?? c.meta.title).replace(new RegExp(`^${name}(?: — |: )`), '');
  const t =
    page === '' || !title
      ? withDomain(title ?? c.meta.title)
      : studio && lead.includes(name)
        ? withDomain(lead)
        : `${lead} | ${name} ${domain}`;
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
  // a service-line page that exists but is not published (EBDA_SERVICE_LINES=preview) is never indexed (SERVICES-IA-1)
  const hidden = page.startsWith('services') && serviceLinesMode() !== 'on';
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
    robots: hidden ? { index: false, follow: false } : { index: true, follow: true },
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
        ...orgServices(locale),
        legalName: locale === 'ar' ? BRAND.company.legalNameAr : BRAND.company.legalNameEn,
        foundingDate: BRAND.company.foundedOn,
        email: BRAND.supportEmail,
        sameAs: SOCIAL_SAME_AS,
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
        ...orgServices(locale),
        legalName: locale === 'ar' ? BRAND.company.legalNameAr : BRAND.company.legalNameEn,
        foundingDate: BRAND.company.foundedOn,
        founder: FOUNDER,
        sameAs: SOCIAL_SAME_AS,
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
 * JSON-LD of a plain page (the legal documents, Contact, Credits, the Services index): the page itself as a WebPage (or a more
 * specific page type), inside the one WebSite and published by the studio Organization, both under the ids every other graph
 * uses. Pre-QA sweep 2026-11-09, finding 4: these pages had no structured data at all; `tests/unit/marketing-jsonld-route-walk.test.tsx`
 * walks the route directory so a new page cannot ship without one.
 */
export function pageJsonLd(
  locale: Locale,
  page: Page,
  name: string,
  description: string,
  opts: {
    type?: 'WebPage' | 'ContactPage' | 'CollectionPage';
    dateModified?: string;
    /** Only a legal document names the registered entity (Ruling AR-STUDIO-NAME-1: never on /contact). */
    legalEntity?: boolean;
  } = {}
) {
  const org = `${SITE_URL}/#organization`;
  const site = `${SITE_URL}/#website`;
  const url = absoluteUrl(pagePath(locale, page));
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
        // What the studio offers (knowsAbout + makesOffer, ~1.3KB) belongs on the Services index; every other plain page
        // names the Organization by identity only (the home and product graphs describe its offers under the same @id).
        // Carrying it on the legal pages pushed their HTML over budget twice over (JSON-LD + its RSC copy), Ruling
        // MKT-LEGAL-HTML-BUDGET-2.
        ...(opts.type === 'CollectionPage' && orgServices(locale)),
        ...(opts.legalEntity && {
          legalName: locale === 'ar' ? BRAND.company.legalNameAr : BRAND.company.legalNameEn,
        }),
        foundingDate: BRAND.company.foundedOn,
        email: BRAND.supportEmail,
      },
      {
        '@type': 'WebSite',
        '@id': site,
        url: absoluteUrl(HOME[locale]),
        name: BRAND.company.shortNameEn,
        alternateName: BRAND.company.shortNameAr,
        inLanguage: locale,
        publisher: { '@id': org },
      },
      {
        '@type': opts.type ?? 'WebPage',
        '@id': `${url}#webpage`,
        url,
        name,
        description,
        inLanguage: locale,
        isPartOf: { '@id': site },
        publisher: { '@id': org },
        ...(opts.dateModified && { dateModified: opts.dateModified }),
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
        ...orgServices(locale),
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
