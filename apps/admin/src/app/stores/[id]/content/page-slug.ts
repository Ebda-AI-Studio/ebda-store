import { slugify } from '@ebda/shared';

/** Same alphabet the product slug uses (Arabic letters kept), 1-64 chars, no leading/trailing dash. Mirrors the API (pages.service). */
export const PAGE_SLUG_REGEX = /^[a-z0-9؀-ۿ](?:[a-z0-9؀-ۿ-]{0,62}[a-z0-9؀-ۿ])?$/;

/** Slugs that are standard pages: never deletable from the merchant admin. Mirrors PROTECTED_PAGE_SLUGS in the API. */
export const PROTECTED_PAGE_SLUGS = [
  'home',
  'about',
  'privacy',
  'terms',
  'shipping',
  'faq',
  'legal',
  'returns',
  'refund',
  'cookies',
  'contact',
];

export const isProtectedPageSlug = (slug: string) =>
  PROTECTED_PAGE_SLUGS.includes(slug.trim().toLowerCase());

/** Name-first: the merchant types a title in Arabic or English; the address is derived (the product slug rule, Arabic kept). */
export function slugFromTitle(title: string): string {
  const s = slugify(title, { max: 64 });
  return PAGE_SLUG_REGEX.test(s) ? s : '';
}
