import { BRAND, BRAND_ADMIN_URL, BRAND_MARKETING_URL } from '@force/shared/brand';

export type Locale = 'ar' | 'en';
export const LOCALES: readonly Locale[] = ['ar', 'en'] as const;

export const SITE_URL = BRAND_MARKETING_URL;
export const LOGIN_URL = `${BRAND_ADMIN_URL}/login`;
export const SIGNUP_URL = `${BRAND_ADMIN_URL}/signup`;
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
export type PageSlug = '' | LegalSlug;

/** Every public marketing page (same set in both locales). The sitemap is generated from this. */
export const SITE_PAGES = ['', ...LEGAL_SLUGS] as const;

/** Page path (no trailing slash except root) for a locale, e.g. pagePath('en','privacy') -> /en/privacy */
export function pagePath(locale: Locale, page: PageSlug): string {
  const base = locale === 'ar' ? '' : '/en';
  const p = page ? `${base}/${page}` : base;
  return p === '' ? '/' : p;
}

export const absoluteUrl = (p: string) =>
  `${SITE_URL}${p === '/' ? '/' : p + '/'}`.replace(/\/\/$/, '/');

/** Section ids, in page order. Ruling R-EBDA-COPY-1 (2026-10-07) and R-EBDA-COPY-5 replaced the 12-section
 *  order from docs/ebda/plans/domains-and-marketing-site.md with this shorter one. */
export const SECTION_ORDER = [
  'story',
  'how',
  'templates',
  'breakout',
  'dahab',
  'features',
  'payments',
  'about',
  'pricing',
  'faq',
  'start',
] as const;
export type SectionId = (typeof SECTION_ORDER)[number];

/** Top-nav items other than the wordmark and the two account actions. */
export const NAV_ANCHORS = [
  { key: 'features', target: 'features' },
  { key: 'solutions', target: 'how' },
  { key: 'pricing', target: 'pricing' },
  { key: 'resources', target: 'faq' },
] as const satisfies readonly { key: string; target: SectionId }[];

/** Company behind Ebda; every mention links here. */
export const COMPANY_URL = 'https://whisky11.com';

/**
 * Customer-stories placeholder. Amelia Aurum is merchant #1; no quotes are
 * published. Set to `null` to remove the name chip entirely.
 */
export const FIRST_MERCHANT: { name: string; domain: string } | null = {
  name: 'Amelia Aurum',
  domain: 'ameliaaurum.com',
};
