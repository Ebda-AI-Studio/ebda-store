import { BRAND, BRAND_STORE_APP_URL, BRAND_MARKETING_URL } from '@ebda/shared/brand';
import { serviceLinesPublished } from './service-lines';

export type Locale = 'ar' | 'en';
export const LOCALES: readonly Locale[] = ['ar', 'en'] as const;

export const SITE_URL = BRAND_MARKETING_URL;
export const LOGIN_URL = `${BRAND_STORE_APP_URL}/login`;
export const SIGNUP_URL = `${BRAND_STORE_APP_URL}/signup`;
/**
 * The live demo stores, one per template (host labels mirror `apps/web/src/lib/demo-hosts.ts`), and
 * the look ids each shows, in the order of the A/B/C looks in `content.ts`. `?look=` previews a look.
 * Keep in step with `scripts/looks/live-shots.mjs`, which captures these.
 */
export const DEMO_STORES = {
  qamar: { host: 'storedemo', looks: ['atelier', 'lookbook', 'vitrine'] },
  souq: { host: 'storedemo-souq', looks: ['catalogue', 'night', 'showroom'] },
  jasmine: { host: 'storedemo-jasmine', looks: ['apothecary', 'bloom', 'clinic'] },
  lamma: { host: 'storedemo-lamma', looks: ['table', 'notebook', 'market'] },
  dahab: { host: 'storedemo-dahab', looks: ['worn', 'workshop', 'giftbox'] },
} as const;
export type DemoTemplate = keyof typeof DEMO_STORES;
export const isDemoTemplate = (id: string): id is DemoTemplate => id in DEMO_STORES;
export const demoLookUrl = (template: DemoTemplate, look: string) =>
  `https://${DEMO_STORES[template].host}${BRAND.domains.storeSuffix}/?look=${template}.${look}`;
export const SECURITY_EMAIL = `security@${BRAND.domains.marketing}`;

/** Home path per locale. Arabic is the default and lives at the root. */
export const HOME: Record<Locale, string> = { ar: '/', en: '/en' };
/** The Ebda Store landing (Ruling MKT-HOME-1): `/` is the Ebda AI Studio home, the Store landing lives here, unchanged. */
export const STORE_HOME: Record<Locale, string> = { ar: '/store', en: '/en/store' };

export const LEGAL_SLUGS = [
  'legal',
  'privacy',
  'terms',
  'merchant-agreement',
  'acceptable-use',
] as const;
export type LegalSlug = (typeof LEGAL_SLUGS)[number];
/**
 * Legal pages that are not Ebda Store acceptance documents (they have no row in LEGAL_POLICIES): the data
 * deletion page and the three Ebda Chat documents. They are legal pages for every other purpose (sitemap
 * date, layout, tests); their own version and date live in legal-extra-*.ts.
 */
export const LEGAL_EXTRA_SLUGS = [
  'legal/data-deletion',
  'legal/whatsapp-terms',
  'legal/whatsapp-privacy',
  'legal/whatsapp-dpa',
  'refund',
] as const;
export type LegalExtraSlug = (typeof LEGAL_EXTRA_SLUGS)[number];
export const COMPARE_SLUGS = [
  'zid',
  'shopify',
  'wuilt',
  'youcan',
  'easyorders',
  'expandcart',
] as const;
export type CompareSlug = (typeof COMPARE_SLUGS)[number];
/** The per-vertical ad landing pages (/for/<slug>/): see lib/verticals.ts. */
export const FOR_SLUGS = ['fashion', 'electronics', 'beauty', 'food', 'jewellery'] as const;
export type ForSlug = (typeof FOR_SLUGS)[number];
export type ForPage = `for/${ForSlug}`;
export const FOR_PAGES: readonly ForPage[] = FOR_SLUGS.map(s => `for/${s}` as const);
export type ComparePage = `compare/${CompareSlug}`;
/** The Services index and the three service-line pages (Ruling SERVICES-IA-1). They are in SITE_PAGES (so the sitemap) only when published (lib/service-lines.ts). */
export type ServiceLinePage = `services/${'marketing' | 'design' | 'events'}`;
export const SERVICE_PAGES: readonly (ServiceLinePage | 'services')[] = [
  'services',
  ...BRAND.serviceLines.map(l => `services/${l.id}` as const),
];
export type PageSlug =
  | ''
  | 'services'
  | ServiceLinePage
  | 'about'
  | 'contact'
  | 'credits'
  | 'support'
  | 'features'
  | 'store'
  | 'whatsapp'
  | ComparePage
  | ForPage
  | LegalSlug
  | LegalExtraSlug;

/** The comparison pages (/compare/{zid,shopify,wuilt,youcan,easyorders,expandcart}), as page slugs. */
export const COMPARE_PAGES: readonly ComparePage[] = COMPARE_SLUGS.map(
  s => `compare/${s}` as const
);

/** Every public marketing page (same set in both locales). The sitemap is generated from this. */
export const SITE_PAGES = [
  '',
  'store',
  'features',
  'whatsapp',
  ...COMPARE_PAGES,
  ...FOR_PAGES,
  ...(serviceLinesPublished() ? SERVICE_PAGES : []),
  'about',
  'contact',
  'credits',
  'support',
  ...LEGAL_SLUGS,
  ...LEGAL_EXTRA_SLUGS,
] as const satisfies readonly PageSlug[];

/** Page path (no trailing slash except root) for a locale, e.g. pagePath('en','privacy') -> /en/privacy */
export function pagePath(locale: Locale, page: PageSlug): string {
  const base = locale === 'ar' ? '' : '/en';
  const p = page ? `${base}/${page}` : base;
  return p === '' ? '/' : p;
}

export const absoluteUrl = (p: string) =>
  `${SITE_URL}${p === '/' ? '/' : p + '/'}`.replace(/\/\/$/, '/');

/** Section ids, in page order. Ruling MKT-1 (2026-10-14): the hero is rendered by Home itself. Ruling MKT-14
 *  (Ahmad, 2026-10-14; it reversed MKT-1's looks-first order): the story scroll first (the four steps, shown
 *  once, the Dahab look building itself), then the looks to use, the live 3D product page (MKT-2), payments,
 *  features, pricing, FAQ, close. The studio story lives on /about, not on the home page. */
export const SECTION_ORDER = [
  'story',
  'looks',
  'model3d',
  'payments',
  'features',
  'ainative',
  'capabilities',
  'pricing',
  'faq',
  'start',
] as const;
export type SectionId = (typeof SECTION_ORDER)[number];

/** The page kinds of the header: a studio page (no product bar), an Ebda Store page or an Ebda Chat page. */
export type PageKind = 'studio' | 'store' | 'chat';
/**
 * Which product a page belongs to (Ruling NAV-PRODUCT-OF-PAGE-1; it replaced MKT-WA-CHROME-1's "everything that is not
 * Chat is Store"). The Store family is an explicit list (the Store landing, /features, /compare/*, /for/*), Chat is its
 * page and its three documents, and the default is `studio`: a new page is never silently Store.
 */
export const productOfPage = (page: string): PageKind =>
  page === 'whatsapp' || page.startsWith('legal/whatsapp-')
    ? 'chat'
    : page === 'store' ||
        page === 'features' ||
        page.startsWith('compare/') ||
        page.startsWith('for/')
      ? 'store'
      : 'studio';

/**
 * Customer-stories placeholder. Null until a merchant has a live, reachable
 * store (the first named merchant's domain did not resolve, 2026-10-08).
 */
export const FIRST_MERCHANT: { name: string; domain: string } | null = null;
