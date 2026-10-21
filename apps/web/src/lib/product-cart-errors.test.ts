/**
 * `PRODUCT_NO_LONGER_AVAILABLE` classification and copy.
 *
 * Scoping the checkout product lookup to `deletedAt: null` turned this refusal
 * from near-dead code into a routine one — soft delete is the admin "delete
 * product" button, and carts live for days. `CheckoutClient` had no case for
 * the code, so every affected customer got "Something went wrong... try again",
 * advice that can never succeed.
 */
import { describe, it, expect } from 'vitest';
import {
  PRODUCT_NO_LONGER_AVAILABLE,
  isProductUnavailableError,
  unavailableProductIds,
  productUnavailableCopy,
  pickProductName,
} from './product-cart-errors';

const t = (en: string, _ar: string) => en;
const tAr = (_en: string, ar: string) => ar;

describe('isProductUnavailableError', () => {
  it('matches the code', () => {
    expect(isProductUnavailableError({ code: PRODUCT_NO_LONGER_AVAILABLE })).toBe(true);
  });

  it('does not match a different failure', () => {
    // Must NOT swallow other codes — each has its own copy and its own action.
    expect(isProductUnavailableError({ code: 'INSUFFICIENT_INVENTORY' })).toBe(false);
    expect(isProductUnavailableError({ code: 'BUNDLE_NOT_PURCHASABLE' })).toBe(false);
    expect(isProductUnavailableError(null)).toBe(false);
    expect(isProductUnavailableError(undefined)).toBe(false);
  });
});

describe('unavailableProductIds', () => {
  it('reads the ids the server put in details', () => {
    expect(
      unavailableProductIds({
        code: PRODUCT_NO_LONGER_AVAILABLE,
        details: { productIds: ['a', 'b'] },
      })
    ).toEqual(['a', 'b']);
  });

  it('returns none for a different error, even if it carries productIds', () => {
    expect(
      unavailableProductIds({ code: 'SOMETHING_ELSE', details: { productIds: ['a'] } })
    ).toEqual([]);
  });

  it('survives a malformed details payload — it crosses a network boundary', () => {
    // Typed on the server, arbitrary here. A bad payload must degrade to
    // "no highlight", never throw inside the error handler itself.
    for (const details of [
      null,
      undefined,
      {} as never,
      { productIds: 'not-an-array' } as never,
      { productIds: [1, 2, null] } as never,
    ]) {
      expect(() =>
        unavailableProductIds({ code: PRODUCT_NO_LONGER_AVAILABLE, details: details as never })
      ).not.toThrow();
    }
    expect(
      unavailableProductIds({
        code: PRODUCT_NO_LONGER_AVAILABLE,
        details: { productIds: [1, 'ok', null] } as never,
      })
    ).toEqual(['ok']);
  });
});

describe('productUnavailableCopy', () => {
  it('tells the customer to remove the item, never to retry', () => {
    // The whole point: "try again" is unachievable advice here.
    const copy = productUnavailableCopy(t, 1);
    expect(copy).toMatch(/remove/i);
    expect(copy).not.toMatch(/try again/i);
  });

  it('is singular for one line and plural for several', () => {
    expect(productUnavailableCopy(t, 1)).toMatch(/An item/);
    expect(productUnavailableCopy(t, 2)).toMatch(/Some items/);
  });

  it('has Arabic for both forms', () => {
    expect(productUnavailableCopy(tAr, 1)).toMatch(/[؀-ۿ]/);
    expect(productUnavailableCopy(tAr, 2)).toMatch(/[؀-ۿ]/);
  });

  it('never renders a raw id — a UUID is meaningless to a shopper', () => {
    const copy = productUnavailableCopy(t, 3);
    expect(copy).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
  });
});

/**
 * Naming the lines is the difference between "remove something" and "remove
 * this". Without it a six-item cart is guess-and-check: remove a line, re-enter
 * checkout, meet the same refusal, repeat.
 */
describe('productUnavailableCopy — naming the offending lines', () => {
  it('names the item when the caller resolved it', () => {
    const copy = productUnavailableCopy(t, 1, ['Blue Kaftan']);
    expect(copy).toMatch(/Blue Kaftan/);
    expect(copy).toMatch(/Remove:/);
  });

  it('lists several, separated', () => {
    const copy = productUnavailableCopy(t, 2, ['Blue Kaftan', 'Gold Abaya']);
    expect(copy).toMatch(/Blue Kaftan/);
    expect(copy).toMatch(/Gold Abaya/);
    expect(copy).toMatch(/Remove:/);
  });

  it('says "Including" — not "Remove" — when the list is PARTIAL', () => {
    // The load-bearing case. Two lines are gone, one name resolved. Promising
    // a complete list is worse than not listing: the customer removes the one
    // named, retries, and meets the identical refusal.
    const copy = productUnavailableCopy(t, 2, ['Blue Kaftan']);
    expect(copy).toMatch(/Including:/);
    expect(copy).not.toMatch(/Remove:/);
  });

  it('falls back to the plain sentence when nothing resolved', () => {
    // The pre-existing behaviour, unchanged — an id that does not match a cart
    // line must not produce a dangling "Remove:" with nothing after it.
    const copy = productUnavailableCopy(t, 2, []);
    expect(copy).not.toMatch(/Remove:|Including:/);
    expect(copy).toMatch(/Some items/);
  });

  it('drops blank names rather than rendering an empty slot', () => {
    const copy = productUnavailableCopy(t, 2, ['Blue Kaftan', '   ']);
    expect(copy).toMatch(/Including:/);
    expect(copy).not.toMatch(/,\s*$/);
  });

  it('keeps the Arabic sentence intact and appends the list after it', () => {
    const copy = productUnavailableCopy(tAr, 1, ['عباية ذهبية']);
    expect(copy).toMatch(/[؀-ۿ]/);
    expect(copy).toMatch(/عباية ذهبية/);
    // The name is appended, never spliced mid-clause — a product name is not
    // translated, and interpolating one into Arabic copy reads as a
    // mixed-direction fragment.
    expect(copy.indexOf('عباية ذهبية')).toBeGreaterThan(copy.indexOf('يرجى'));
  });
});

describe('pickProductName (#1805)', () => {
  it('picks nameAr in Arabic when it is a real translation', () => {
    expect(pickProductName({ name: 'Blue Kaftan', nameAr: 'قفطان أزرق' }, 'ar')).toBe('قفطان أزرق');
  });

  it('picks name in English regardless of nameAr', () => {
    expect(pickProductName({ name: 'Blue Kaftan', nameAr: 'قفطان أزرق' }, 'en')).toBe(
      'Blue Kaftan'
    );
  });

  it('falls back to name in Arabic when nameAr is an EMPTY STRING — the reported defect', () => {
    // The admin new-product form seeds nameAr: '' (not null) for an
    // untranslated product. `nameAr ?? name` only falls back on null/
    // undefined, so it resolved to '' here — this is the truthiness idiom
    // OrderSummary.tsx and CartContext.tsx already use, and the one
    // CheckoutClient.tsx was missing.
    expect(pickProductName({ name: 'Blue Kaftan', nameAr: '' }, 'ar')).toBe('Blue Kaftan');
  });

  it('falls back to name in Arabic when nameAr is null or undefined', () => {
    expect(pickProductName({ name: 'Blue Kaftan', nameAr: null }, 'ar')).toBe('Blue Kaftan');
    expect(pickProductName({ name: 'Blue Kaftan' }, 'ar')).toBe('Blue Kaftan');
  });

  it('an untranslated product no longer silently downgrades the whole checkout message to "Including" (integration of the two fixes)', () => {
    const names = [
      { name: 'Blue Kaftan', nameAr: 'قفطان أزرق' },
      { name: 'Gold Abaya', nameAr: '' }, // untranslated
    ].map(p => pickProductName(p, 'ar'));

    const copy = productUnavailableCopy(tAr, 2, names);
    // Both names resolved (one Arabic, one English fallback) — the list is
    // COMPLETE, so the copy says "Remove:", not the weaker "Including:".
    expect(copy).toMatch(/شيل:/);
    expect(copy).toContain('قفطان أزرق');
    expect(copy).toContain('Gold Abaya');
  });
});
