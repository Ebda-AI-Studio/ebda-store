import { BRAND, BRAND_ADMIN_URL, BRAND_MARKETING_URL } from '@force/shared/brand';

export type Locale = 'ar' | 'en';
export const LOCALES: readonly Locale[] = ['ar', 'en'] as const;

export const SITE_URL = BRAND_MARKETING_URL;
export const LOGIN_URL = `${BRAND_ADMIN_URL}/login`;
export const SIGNUP_URL = `${BRAND_ADMIN_URL}/signup`;
export const SECURITY_EMAIL = `security@${BRAND.domains.marketing}`;

/** Home path per locale. Arabic is the default and lives at the root. */
export const HOME: Record<Locale, string> = { ar: '/', en: '/en' };

/** Page path (no trailing slash except root) for a locale, e.g. pagePath('en','privacy') -> /en/privacy */
export function pagePath(locale: Locale, page: '' | 'legal' | 'privacy' | 'terms'): string {
  const base = locale === 'ar' ? '' : '/en';
  const p = page ? `${base}/${page}` : base;
  return p === '' ? '/' : p;
}

export const absoluteUrl = (p: string) =>
  `${SITE_URL}${p === '/' ? '/' : p + '/'}`.replace(/\/\/$/, '/');

/** Section ids, in the binding page order (docs/ebda/plans §5 SP9). */
export const SECTION_ORDER = [
  'create',
  'how',
  'builder',
  'products',
  'orders',
  'payments',
  'whatsapp',
  'analytics',
  'pricing',
  'stories',
  'faq',
  'login',
] as const;
export type SectionId = (typeof SECTION_ORDER)[number];

/** Top-nav items other than the wordmark and the two account actions. */
export const NAV_ANCHORS = [
  { key: 'features', target: 'builder' },
  { key: 'solutions', target: 'how' },
  { key: 'pricing', target: 'pricing' },
  { key: 'resources', target: 'faq' },
] as const satisfies readonly { key: string; target: SectionId }[];

/**
 * Customer-stories placeholder. Amelia Aurum is merchant #1; no quotes are
 * published. Set to `null` to remove the name chip entirely.
 */
export const FIRST_MERCHANT: { name: string; domain: string } | null = {
  name: 'Amelia Aurum',
  domain: 'ameliaaurum.com',
};
