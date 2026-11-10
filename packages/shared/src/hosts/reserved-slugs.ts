/**
 * Reserved store slugs. The base list is the vendored ebda-foundation (`slugs`, foundation.lock.json, hash-locked, never edited here);
 * this module adds the labels Ebda AI Studio needs on `*.ebda.app` that are not in the foundation yet, plus a prefix rule.
 * Signup, store create/update (API), the host parser and the resolver all import THIS module; never copy the list.
 * Foundation follow-up: move STORE_EXTRA_RESERVED_SLUGS / RESERVED_SLUG_PREFIXES into `slugs.ts` upstream, then delete them here.
 */
import {
  RESERVED_SLUGS as FOUNDATION_RESERVED_SLUGS,
  isDemoShowroomSlug,
  isReservedSlug as isFoundationReservedSlug,
} from '../foundation/slugs';

/** Labels reserved on top of the foundation list: hosts Ebda AI Studio runs itself. */
export const STORE_EXTRA_RESERVED_SLUGS = [
  'events',
  'marketing',
  'design',
  'os',
  'studio',
  'checkin',
  'manage',
  // coming-soon software with a coming-soon page at <label>.ebda.app (Ruling SUBDOMAIN-SOON-2): Ebda Invite, Ebda Ads,
  // Ebda Quote Studio (`quote` and its BRAND id `quote-studio`)
  'invite',
  'ads',
  'quote',
  'quote-studio',
  // Ebda Chat's other name: 301 to wa.ebda.app (Ruling WHATSAPP-HOST-REDIRECT-1)
  'chat',
] as const;

/** Any slug starting with one of these is reserved (per-deployment preview hosts). */
export const RESERVED_SLUG_PREFIXES = ['preview-'] as const;

export const RESERVED_SLUGS = [
  ...FOUNDATION_RESERVED_SLUGS,
  ...STORE_EXTRA_RESERVED_SLUGS,
] as const;

export type ReservedSlug = (typeof RESERVED_SLUGS)[number];

/** True when `slug` (case-insensitive, trimmed) is reserved (exact label or reserved prefix) and can never be a store. */
export function isReservedSlug(slug: string | null | undefined): boolean {
  if (typeof slug !== 'string') return false;
  if (isFoundationReservedSlug(slug)) return true;
  const s = slug.trim().toLowerCase();
  return (
    (STORE_EXTRA_RESERVED_SLUGS as readonly string[]).includes(s) ||
    RESERVED_SLUG_PREFIXES.some(p => s.startsWith(p))
  );
}

export { isDemoShowroomSlug };
