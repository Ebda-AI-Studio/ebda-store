import { BRAND, BRAND_STORE_APP_URL, BRAND_MARKETING_URL } from '@ebda/shared/brand';

export type Locale = 'ar' | 'en';
export const LOCALES: readonly Locale[] = ['ar', 'en'] as const;

export const SITE_URL = BRAND_MARKETING_URL;
export const LOGIN_URL = `${BRAND_STORE_APP_URL}/login`;
export const SIGNUP_URL = `${BRAND_STORE_APP_URL}/signup`;
export const SECURITY_EMAIL = `security@${BRAND.domains.marketing}`;

/** Home path per locale. Arabic is the default and lives at the root. */
export const HOME: Record<Locale, string> = { ar: '/', en: '/en' };

export const LEGAL_SLUGS = [
  'legal',
  'privacy',
  'terms',
  'merchant-agreement',
  'acceptable-use',
] as const;
export type LegalSlug = (typeof LEGAL_SLUGS)[number];
export type PageSlug = '' | 'about' | 'credits' | LegalSlug;

/** Every public marketing page (same set in both locales). The sitemap is generated from this. */
export const SITE_PAGES = ['', 'about', 'credits', ...LEGAL_SLUGS] as const;

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
  'pricing',
  'faq',
  'start',
] as const;
export type SectionId = (typeof SECTION_ORDER)[number];

/** Top-nav items other than the wordmark and the account actions, in page order. */
export const NAV_ANCHORS = [
  { key: 'solutions', target: 'story' },
  { key: 'looks', target: 'looks' },
  { key: 'features', target: 'features' },
  { key: 'pricing', target: 'pricing' },
  { key: 'resources', target: 'faq' },
] as const satisfies readonly { key: string; target: SectionId }[];

/**
 * Customer-stories placeholder. Null until a merchant has a live, reachable
 * store (the first named merchant's domain did not resolve, 2026-10-08).
 */
export const FIRST_MERCHANT: { name: string; domain: string } | null = null;
