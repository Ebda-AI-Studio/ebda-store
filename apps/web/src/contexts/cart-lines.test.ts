/**
 * #1766 — a line whose product was deleted is carried through from the API
 * (`unavailable`) and excluded from the cart's count and total, so the badge,
 * the cart page and the checkout summary all agree with the server subtotal.
 */
import { describe, it, expect } from 'vitest';
import { cartTotals, mapServerItem, sameLine } from './cart-lines';
import { toSyncPayload } from './cart-hydration';

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

describe('mapServerItem: the server-resolved B2B price wins (the cart never multiplies a catalogue price)', () => {
  it('uses unitPrice over the variant and product prices and carries provenance and MOQ state', () => {
    const line = mapServerItem(
      server({
        variant: { id: 'v1', title: 'XL', price: 12000 },
        unitPrice: 8500,
        listPrice: 12000,
        priceSource: 'tier',
        priceTierMinQty: 10,
        belowMoq: true,
        moqRequired: 12,
      })
    );
    expect(line).toMatchObject({
      price: 8500,
      listPrice: 12000,
      priceSource: 'tier',
      priceTierMinQty: 10,
      belowMoq: true,
      moqRequired: 12,
    });
    // so the displayed line total and cartTotals equal the server's lineTotal / subtotal
    expect(cartTotals([line], []).total).toBe(8500 * 2);
  });

  it('falls back to variant price, then product price, when the server sent no unitPrice (unavailable line / older API)', () => {
    expect(mapServerItem(server({ variant: { id: 'v1', title: 'S', price: 6000 } })).price).toBe(
      6000
    );
    expect(mapServerItem(server()).price).toBe(5000);
    expect(mapServerItem(server()).belowMoq).toBeUndefined();
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

describe('sameLine (personalisation is part of the line identity)', () => {
  const base = { productId: 'p1', variantId: 'v1' };
  it('splits lines that differ only by note', () => {
    expect(sameLine({ ...base, note: 'Sara' }, { ...base, note: 'Omar' })).toBe(false);
    expect(sameLine({ ...base, note: 'Sara' }, { ...base })).toBe(false);
  });
  it('merges the same note, and treats missing/undefined variant + note alike', () => {
    expect(sameLine({ ...base, note: 'Sara' }, { ...base, note: 'Sara' })).toBe(true);
    expect(sameLine({ productId: 'p1' }, { productId: 'p1', variantId: undefined })).toBe(true);
    expect(sameLine({ ...base }, { ...base, variantId: 'v2' })).toBe(false);
  });
});

describe('note round-trips through the cart helpers', () => {
  it('mapServerItem carries the note; null becomes undefined', () => {
    expect(mapServerItem(server({ note: 'سارة' })).note).toBe('سارة');
    expect(mapServerItem(server({ note: null })).note).toBeUndefined();
  });
  it('toSyncPayload keeps the note so the guest sync cannot merge two names', () => {
    const line = (note?: string) =>
      ({ id: 'x', productId: 'p1', quantity: 1, name: 'A', price: 1, slug: 'a', note }) as never;
    expect(toSyncPayload([line('Sara'), line('Omar'), line()])).toEqual([
      { productId: 'p1', quantity: 1, variantId: undefined, note: 'Sara' },
      { productId: 'p1', quantity: 1, variantId: undefined, note: 'Omar' },
      { productId: 'p1', quantity: 1, variantId: undefined },
    ]);
  });
});
