/**
 * #670 — new/page.tsx and edit/page.tsx each called
 * `decodeURIComponent(searchParams.get('returnTo'))`, but
 * `useSearchParams().get()` already decodes once. A `returnTo` carrying a
 * literal `%` (a products-list filter with `%` in a search term) either threw
 * (silently falling back) or misdecoded into a different string that could
 * still pass the `startsWith` open-redirect guard.
 *
 * Mutation-proof: restoring the old double-decode (wrap `raw` in an extra
 * `decodeURIComponent`) reddens the "does not misdecode a literal percent
 * sign" case below — `%zz` is not valid percent-encoding and throws on a
 * second decode, changing the returned value.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeReturnTo } from '../return-to';

const BASE = '/stores/s1/products';

describe('sanitizeReturnTo', () => {
  it('falls back to base when returnTo is absent', () => {
    expect(sanitizeReturnTo(null, BASE)).toBe(BASE);
    expect(sanitizeReturnTo(undefined, BASE)).toBe(BASE);
    expect(sanitizeReturnTo('', BASE)).toBe(BASE);
  });

  it('passes through an in-app returnTo unchanged (single decode already done by the caller)', () => {
    // A querystring `?returnTo=%2Fstores%2Fs1%2Fproducts%3Ffilter%3D%2550`
    // arrives here as `searchParams.get()` already decoded it once, to a
    // literal '%' from an encoded '%25':
    const alreadyDecodedOnce = `${BASE}?filter=%50`;
    expect(sanitizeReturnTo(alreadyDecodedOnce, BASE)).toBe(alreadyDecodedOnce);
  });

  it('does not misdecode a literal percent sign (the reported defect)', () => {
    // '%zz' is not valid percent-encoding. The OLD code ran this through a
    // SECOND decodeURIComponent and threw, silently falling back to base
    // instead of preserving the shopper's actual filter.
    const withLiteralPercent = `${BASE}?q=100%zz`;
    expect(sanitizeReturnTo(withLiteralPercent, BASE)).toBe(withLiteralPercent);
  });

  it('rejects a returnTo that does not point back into this store product list (open-redirect guard)', () => {
    expect(sanitizeReturnTo('https://evil.example.com', BASE)).toBe(BASE);
    expect(sanitizeReturnTo('/stores/s2/products', BASE)).toBe(BASE);
    expect(sanitizeReturnTo('//evil.example.com', BASE)).toBe(BASE);
  });

  // Ported from the o3 batch's regression suite (#669/#670) when main's
  // sanitizeReturnTo superseded its identical resolveReturnTo.
  it('does not double-decode a raw value carrying an encoded percent sign', () => {
    // A category filter literally named "50% off", round-tripped through one
    // encode/decode cycle already by the time this function sees it.
    const raw = `${BASE}?category=50%25+off`;
    expect(sanitizeReturnTo(raw, BASE)).toBe(raw);
  });

  it('does not throw on a raw value with an invalid percent-escape', () => {
    const raw = `${BASE}?q=50%+off`;
    expect(() => sanitizeReturnTo(raw, BASE)).not.toThrow();
    expect(sanitizeReturnTo(raw, BASE)).toBe(raw);
  });
});
