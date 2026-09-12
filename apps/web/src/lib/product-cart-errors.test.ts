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
