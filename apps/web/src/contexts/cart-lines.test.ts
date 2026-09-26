/**
 * #1766 — a line whose product was deleted is carried through from the API
 * (`unavailable`) and excluded from the cart's count and total, so the badge,
 * the cart page and the checkout summary all agree with the server subtotal.
 */
import { describe, it, expect } from 'vitest';
import { cartTotals, mapServerItem } from './cart-lines';

const server = (extra: Record<string, unknown> = {}) => ({
  id: 'l1',
  productId: 'p1',
  quantity: 2,
  product: { id: 'p1', name: 'A', slug: 'a', price: 5000 },
  ...extra,
});

describe('mapServerItem', () => {
  it('carries the unavailable flag from the API', () => {
    expect(mapServerItem(server({ unavailable: true })).unavailable).toBe(true);
    expect(mapServerItem(server()).unavailable).toBeUndefined();
    expect(mapServerItem(server({ unavailable: false })).unavailable).toBeUndefined();
  });
});

describe('cartTotals', () => {
  it('excludes unavailable lines from both count and total', () => {
    const r = cartTotals(
      [
        { price: 5000, quantity: 2 },
        { price: 3000, quantity: 3, unavailable: true },
      ],
      [{ quantity: 1, total: 7000 }]
    );
    expect(r).toEqual({ itemCount: 3, total: 17000 });
  });

  it('is unchanged for a cart with no unavailable line', () => {
    expect(
      cartTotals(
        [
          { price: 5000, quantity: 2 },
          { price: 3000, quantity: 3 },
        ],
        []
      )
    ).toEqual({ itemCount: 5, total: 19000 });
  });
});
