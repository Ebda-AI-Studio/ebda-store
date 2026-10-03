/**
 * SP5 task 4 - protected (brand / trademark) store names.
 *
 * Mutation proof (recorded in the commit body): in
 * packages/shared/src/abuse/protected-slugs.ts make `readings()` skip the
 * leetspeak fold (return only `stripped`) -> the "leetspeak" cases fail
 * (`p4ym0b`, `f4wry`, `1nstapay` stop matching).
 */
import { describe, it, expect } from 'vitest';
import {
  isProtectedSlug,
  matchProtectedName,
  normalizeSlugForMatch,
  validateStoreSlug,
  isReservedSlug,
} from '@force/shared';

describe('protected slug matching', () => {
  it.each([
    ['ebda', 'platform name'],
    ['ebda-support', 'platform confusable'],
    ['ebdasupport', 'hyphen removed'],
    ['3bda', 'leetspeak 3 -> e'],
    ['whisky-11', 'operator name with digits'],
    ['paymob', 'payment brand'],
    ['pay-mob', 'hyphen inside brand'],
    ['paymob24', 'trailing digits stripped'],
    ['p4ym0b', 'leetspeak 4/0'],
    ['fawry', 'payment brand'],
    ['f4wry', 'leetspeak'],
    ['instapay', 'payment brand'],
    ['1nstapay', 'leetspeak 1 -> i'],
    ['pay1pal', 'leetspeak 1 -> l'],
    ['vodafone-cash', 'multi-word brand with hyphen'],
    ['vodafonecash', 'multi-word brand joined'],
    ['v0dafone-cash2', 'leet + digit'],
    ['paymob-support', 'brand + impersonation word'],
    ['official-fawry', 'impersonation word + brand'],
    ['officialfawry', 'joined'],
    ['my-store-paymob', 'brand as one word of the slug'],
    ['nike-outlet', 'global brand token'],
    ['paymmob', 'doubled letter'],
    ['dell', 'short brand, exact'],
  ])('blocks %s (%s)', slug => {
    expect(isProtectedSlug(slug)).toBe(true);
  });

  it.each([
    'amelia',
    'wady-aljuz',
    'pineapple', // contains "apple" but is a different word
    'pineapple-shop',
    'coolshop',
    'nonsense',
    'anike',
    'my-flower-shop',
    'cairo-spices',
    'del-a-1f3c9b2e', // "del" is not the brand "dell"
  ])('allows %s', slug => {
    expect(isProtectedSlug(slug)).toBe(false);
  });

  it('is case-insensitive and tolerates null', () => {
    expect(isProtectedSlug('PayMob')).toBe(true);
    expect(isProtectedSlug(null)).toBe(false);
    expect(isProtectedSlug('')).toBe(false);
  });

  it('reports the brand form it matched', () => {
    expect(matchProtectedName('ebda-support')).toBe('ebdasupport');
    expect(matchProtectedName('ebda-shop')).toBe('ebda');
    expect(matchProtectedName('vodafone-cash')).toBe('vodafonecash');
  });

  it('normalizes hyphens, digits and leetspeak into comparable forms', () => {
    const forms = normalizeSlugForMatch('V0dafone-C4sh-2');
    expect(forms).toContain('vodafonecash');
  });
});

describe('validateStoreSlug with the protected list', () => {
  it('refuses a protected brand with SLUG_PROTECTED and a contact-support message', () => {
    const r = validateStoreSlug('paymob');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('SLUG_PROTECTED');
      expect(r.message).toMatch(/contact support/i);
    }
  });

  it('super_admin override lifts ONLY the protected list, never the reserved one', () => {
    expect(validateStoreSlug('paymob', { allowProtected: true })).toEqual({
      ok: true,
      slug: 'paymob',
    });
    expect(isReservedSlug('api')).toBe(true);
    const r = validateStoreSlug('api', { allowProtected: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SLUG_RESERVED');
  });

  it('keeps reserved labels as SLUG_RESERVED (a separate list)', () => {
    const r = validateStoreSlug('support');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SLUG_RESERVED');
  });
});
