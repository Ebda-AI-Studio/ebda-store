import { z } from 'zod/v3';
import { isReservedSlug, isDemoShowroomSlug } from './reserved-slugs';
import { isProtectedSlug } from '../abuse/protected-slugs';
import { SLUG_MAX_LENGTH, SLUG_MIN_LENGTH, slugFormatError } from '../foundation/slugs';

export const STORE_SLUG_MIN_LENGTH = SLUG_MIN_LENGTH;
export const STORE_SLUG_MAX_LENGTH = SLUG_MAX_LENGTH;

/** Machine-readable reasons a store slug is refused. Stable: clients key on these. */
export type StoreSlugErrorCode =
  | 'SLUG_TOO_SHORT'
  | 'SLUG_TOO_LONG'
  | 'SLUG_INVALID_CHARS'
  | 'SLUG_INVALID_HYPHEN'
  | 'SLUG_RESERVED'
  | 'SLUG_PROTECTED';

export type StoreSlugValidation =
  | { ok: true; slug: string }
  | { ok: false; code: StoreSlugErrorCode; message: string };

/** Human-readable text per code (English; the admin maps codes to Arabic copy). */
export const STORE_SLUG_ERROR_MESSAGES: Record<StoreSlugErrorCode, string> = {
  SLUG_TOO_SHORT: `Store address must be at least ${STORE_SLUG_MIN_LENGTH} characters`,
  SLUG_TOO_LONG: `Store address must be at most ${STORE_SLUG_MAX_LENGTH} characters`,
  SLUG_INVALID_CHARS: 'Store address may only contain lowercase letters, digits and hyphens',
  SLUG_INVALID_HYPHEN:
    'Store address cannot start or end with a hyphen or contain two hyphens in a row',
  SLUG_RESERVED: 'This store address is reserved. Please choose another one',
  SLUG_PROTECTED:
    'This store address matches a protected brand name. Contact support to claim it, or choose another one',
};

/**
 * Format-only check (no reserved-list lookup): lowercase a-z0-9 and hyphen,
 * 3–40 chars, no leading/trailing/double hyphen. Input is NOT normalised —
 * `Amelia` is invalid, not silently lowercased — so what is validated is
 * exactly what gets stored and routed.
 */
export function validateStoreSlugFormat(raw: string): StoreSlugValidation {
  const slug = raw;
  const fail = (code: StoreSlugErrorCode): StoreSlugValidation => ({
    ok: false,
    code,
    message: STORE_SLUG_ERROR_MESSAGES[code],
  });
  const error = slugFormatError(slug);
  if (error) return fail(error);
  return { ok: true, slug };
}

/**
 * Full validation: format, the reserved list (our own labels — never
 * overridable), then the protected brand list (`SLUG_PROTECTED`, normalised:
 * hyphens/digits stripped, leetspeak folded). `allowProtected` is the
 * super-admin support-claim override and skips ONLY the brand list.
 */
export function validateStoreSlug(
  raw: string,
  opts: { allowProtected?: boolean } = {}
): StoreSlugValidation {
  const format = validateStoreSlugFormat(raw);
  if (!format.ok) return format;
  // The demo showroom family belongs to the seed (Ruling B2-17); never overridable.
  if (isReservedSlug(format.slug) || isDemoShowroomSlug(format.slug)) {
    return { ok: false, code: 'SLUG_RESERVED', message: STORE_SLUG_ERROR_MESSAGES.SLUG_RESERVED };
  }
  if (!opts.allowProtected && isProtectedSlug(format.slug)) {
    return {
      ok: false,
      code: 'SLUG_PROTECTED',
      message: STORE_SLUG_ERROR_MESSAGES.SLUG_PROTECTED,
    };
  }
  return format;
}

/**
 * Zod schema for a store slug. The failing code rides on the issue's `params`
 * (`{ code: 'SLUG_RESERVED' }`) so an API route can surface it as a first-class
 * error code instead of a generic VALIDATION_ERROR — see `storeSlugIssueCode`.
 */
export const storeSlugSchema = z.string().superRefine((value, ctx) => {
  // Protected brand names are enforced where the actor is known (the API's
  // `assertStoreSlug` / onboarding), so a super_admin can override; this schema
  // has no actor and checks format + reserved only.
  const result = validateStoreSlug(value, { allowProtected: true });
  if (!result.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: result.message,
      params: { code: result.code },
    });
  }
});

/** The `StoreSlugErrorCode` carried by a ZodError issue produced by {@link storeSlugSchema}, if any. */
export function storeSlugIssueCode(issue: {
  code: string;
  params?: unknown;
}): StoreSlugErrorCode | null {
  if (issue.code !== 'custom') return null;
  const code = (issue.params as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && code.startsWith('SLUG_') ? (code as StoreSlugErrorCode) : null;
}
