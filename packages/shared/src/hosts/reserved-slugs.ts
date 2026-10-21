/**
 * Reserved store slugs — the SINGLE source of truth.
 *
 * A store lives at `<slug>.ebda.app`, so a slug that equals one of our own
 * service labels (`app`, `api`, `orders`, …) would either collide with a real
 * host or let a merchant impersonate the platform. Signup, store create/update
 * (API), the host parser and the resolver all import THIS list; never copy it.
 *
 * Program plan §1 / design cloudflare-backend §4. Adding a label here is a
 * one-line change that takes effect everywhere.
 */
export const RESERVED_SLUGS = [
  'app',
  'api',
  'docs',
  'help',
  'status',
  'whatsapp',
  'www',
  'admin',
  'orders',
  'mail',
  'cdn',
  'assets',
  'static',
  'store',
  'dashboard',
  'billing',
  'support',
  'blog',
  // Ebda product family (PRODUCT-NAME-1): `store` also hosts cache revalidation.
  'crm',
  'erp',
  'hub',
  'id',
  'accounts',
] as const;

export type ReservedSlug = (typeof RESERVED_SLUGS)[number];

const RESERVED_SET: ReadonlySet<string> = new Set(RESERVED_SLUGS);

/** True when `slug` (case-insensitive, trimmed) is reserved and can never be a store. */
export function isReservedSlug(slug: string | null | undefined): boolean {
  if (typeof slug !== 'string') return false;
  return RESERVED_SET.has(slug.trim().toLowerCase());
}

/**
 * The demo showroom family (Ruling B2-17): `storedemo` (Qamar) and `storedemo-*` (`storedemo-souq`,
 * a future template). These belong to `scripts/storedemo/seed.mjs`; a merchant who registered one
 * first would be overwritten by the seed, or would impersonate the official demo. Refused on
 * SIGNUP / create / slug change (`validateStoreSlug`) but deliberately NOT in RESERVED_SLUGS: a
 * reserved label is a PLATFORM host, and `storedemo.ebda.app` must keep resolving as a store.
 * `demo*` in general is not reserved (ordinary merchants use `demo-shop`).
 */
export function isDemoShowroomSlug(slug: string | null | undefined): boolean {
  if (typeof slug !== 'string') return false;
  return slug.trim().toLowerCase().startsWith('storedemo');
}
