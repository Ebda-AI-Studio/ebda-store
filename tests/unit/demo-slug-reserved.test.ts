/**
 * Ruling B2-17 (security review): the demo showroom slugs are unclaimable. `storedemo` and every
 * `storedemo*` slug belongs to the seed: a merchant must not register one (the seed would then
 * overwrite their store, or their store would impersonate the official demo). The block is on the
 * SIGNUP / CREATE / SLUG-CHANGE paths (`validateStoreSlug`, `deriveStoreSlug`); the host parser and
 * the resolver must keep serving `storedemo.ebda.app`, so the demo slugs are NOT in RESERVED_SLUGS
 * (a reserved label is a platform host and would stop the showroom resolving).
 */
import { describe, it, expect } from 'vitest';
import {
  validateStoreSlug,
  validateStoreSlugFormat,
  storeSlugSchema,
  isReservedSlug,
  isDemoShowroomSlug,
  parseStoreHost,
} from '@ebda/shared';
import { deriveStoreSlug } from '../../apps/api/src/lib/store-slug';

const DEMO = ['storedemo', 'storedemo-souq', 'storedemo-qamar', 'storedemo-2', 'storedemo-x-y'];
const ALLOWED = [
  'demo-shop',
  'my-storedemo',
  'store-demo',
  'demostore',
  // M5: only `storedemo` and `storedemo-*` are the showroom's; these are ordinary merchant slugs
  'storedemos',
  'storedemonstration',
];

describe('demo showroom slugs are not claimable', () => {
  it.each(DEMO)('validateStoreSlug(%s) -> SLUG_RESERVED', slug => {
    const r = validateStoreSlug(slug);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SLUG_RESERVED');
    // the super-admin protected-brand override never lifts it (it only skips the brand list)
    const sa = validateStoreSlug(slug, { allowProtected: true });
    expect(sa.ok).toBe(false);
  });
  it.each(DEMO)('storeSlugSchema (the zod edge) refuses %s with the stable code', slug => {
    const r = storeSlugSchema.safeParse(slug);
    expect(r.success).toBe(false);
    if (!r.success)
      expect((r.error.issues[0] as { params?: { code?: string } }).params?.code).toBe(
        'SLUG_RESERVED'
      );
  });
  it('the DEMO slugs are recognised case-insensitively and trimmed', () => {
    for (const s of [' StoreDemo ', 'STOREDEMO-SOUQ']) expect(isDemoShowroomSlug(s)).toBe(true);
    for (const s of ALLOWED) expect(isDemoShowroomSlug(s), s).toBe(false);
    expect(isDemoShowroomSlug(null)).toBe(false);
    expect(isDemoShowroomSlug(undefined)).toBe(false);
  });
  it.each(ALLOWED)('an ordinary slug (%s) is still claimable', slug => {
    expect(validateStoreSlug(slug).ok).toBe(true);
  });
  it('a name-derived slug never lands on the demo family', () => {
    for (const name of ['storedemo', 'StoreDemo Cairo', 'storedemo-souq']) {
      const slug = deriveStoreSlug(name.toLowerCase().replace(/\s+/g, '-'));
      expect(isDemoShowroomSlug(slug), name).toBe(false);
      expect(validateStoreSlugFormat(slug).ok).toBe(true);
    }
  });
});

describe('but the showroom hosts still resolve (they are not RESERVED_SLUGS)', () => {
  it('the demo slugs are not platform labels', () => {
    for (const s of ['storedemo', 'storedemo-souq']) expect(isReservedSlug(s)).toBe(false);
  });
  it('the resolver-side format check still accepts them', () => {
    for (const s of ['storedemo', 'storedemo-souq'])
      expect(validateStoreSlugFormat(s).ok).toBe(true);
  });
  it('parseStoreHost still reads storedemo(.-souq).ebda.app as a store subdomain', () => {
    for (const label of ['storedemo', 'storedemo-souq'])
      expect(parseStoreHost(`${label}.ebda.app`).kind).toBe('subdomain');
  });
});
