import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readLocalCart, toSyncPayload } from '../../apps/web/src/contexts/cart-hydration';

const item = (over: Record<string, unknown> = {}) =>
  ({
    id: 'p1',
    productId: 'p1',
    name: 'Thing',
    price: 100,
    quantity: 1,
    slug: 'thing',
    ...over,
  }) as never;

describe('readLocalCart', () => {
  const store: Record<string, string> = {};
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns the persisted cart', () => {
    store.cart = JSON.stringify([item({ id: 'a' })]);
    expect(readLocalCart('cart').map(i => i.id)).toEqual(['a']);
  });

  it('returns empty when nothing is stored', () => {
    expect(readLocalCart('cart')).toEqual([]);
  });

  it('returns empty on corrupt JSON rather than throwing', () => {
    // A throw here would break hydration and lose the shopper's basket.
    store.cart = '{not json';
    expect(readLocalCart('cart')).toEqual([]);
  });

  it('rejects a non-array payload from an older schema', () => {
    // Passing an object downstream to .filter/.map would throw.
    store.cart = JSON.stringify({ items: [] });
    expect(readLocalCart('cart')).toEqual([]);
  });

  it('returns empty when storage is unavailable (Safari private mode)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
    });
    expect(readLocalCart('cart')).toEqual([]);
  });
});

describe('toSyncPayload', () => {
  it('maps productId, quantity and variantId', () => {
    expect(toSyncPayload([item({ productId: 'p9', quantity: 3, variantId: 'v1' })])).toEqual([
      { productId: 'p9', quantity: 3, variantId: 'v1' },
    ]);
  });

  it('falls back to id when productId is absent', () => {
    // Before the first server round-trip, `id` holds the productId.
    expect(toSyncPayload([item({ id: 'p7', productId: '' })])[0].productId).toBe('p7');
  });

  it('drops entries with no usable product id', () => {
    expect(toSyncPayload([item({ id: '', productId: '' })])).toEqual([]);
  });

  it('drops non-positive quantities', () => {
    expect(toSyncPayload([item({ quantity: 0 }), item({ quantity: -2 })])).toEqual([]);
  });

  it('keeps the valid entries when only some are broken', () => {
    const out = toSyncPayload([item({ productId: 'ok' }), item({ id: '', productId: '' })]);
    expect(out.map(i => i.productId)).toEqual(['ok']);
  });

  it('prefers productId over id when both are present', () => {
    // `id` is only a fallback for the pre-sync optimistic case.
    expect(toSyncPayload([item({ id: 'row-id', productId: 'real' })])[0].productId).toBe('real');
  });
});
