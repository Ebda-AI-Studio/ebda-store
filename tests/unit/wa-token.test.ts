import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  sessionGet,
  sessionSet,
  parseWaCartPayload,
  isRedeemableItem,
  isRedeemableBundle,
  hydrateBundles,
  urlWithoutToken,
} from '../../apps/web/src/app/checkout/wa-token';

afterEach(() => vi.unstubAllGlobals());

describe('sessionGet / sessionSet — must never throw on the checkout path', () => {
  it('reads and writes normally', () => {
    const store: Record<string, string> = {};
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => {
          store[k] = v;
        },
      },
    });
    sessionSet('k', 'v');
    expect(sessionGet('k')).toBe('v');
  });

  it('returns null instead of throwing when storage is blocked', () => {
    // Safari private mode THROWS on access. A throw here aborts redemption and
    // the shopper loses the basket they built in WhatsApp.
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: () => {
          throw new Error('SecurityError');
        },
        setItem: () => {
          throw new Error('SecurityError');
        },
      },
    });
    expect(sessionGet('k')).toBeNull();
    expect(() => sessionSet('k', 'v')).not.toThrow();
  });
});

describe('parseWaCartPayload', () => {
  it('accepts a payload with items', () => {
    const out = parseWaCartPayload({ data: { items: [{ productId: 'p', quantity: 1 }] } });
    expect(out?.items).toHaveLength(1);
  });

  it('rejects missing data, non-array items and an empty cart', () => {
    // An empty cart is "nothing to do", not an error — same null either way.
    expect(parseWaCartPayload(undefined)).toBeNull();
    expect(parseWaCartPayload({})).toBeNull();
    expect(parseWaCartPayload({ data: {} })).toBeNull();
    expect(parseWaCartPayload({ data: { items: 'nope' } })).toBeNull();
    expect(parseWaCartPayload({ data: { items: [] } })).toBeNull();
  });

  it('carries customerPhone through for the shipping pre-fill', () => {
    const out = parseWaCartPayload({
      data: { items: [{ productId: 'p', quantity: 1 }], customerPhone: '+965' },
    });
    expect(out?.customerPhone).toBe('+965');
  });

  it('accepts a bundle-only payload — zero loose items is not "empty" when bundles are present', () => {
    const out = parseWaCartPayload({
      data: { items: [], bundles: [{ bundleId: 'b', quantity: 1 }] },
    });
    expect(out).not.toBeNull();
    expect(out?.items).toHaveLength(0);
    expect(out?.bundles).toHaveLength(1);
  });

  it('accepts a mixed payload (products + bundles)', () => {
    const out = parseWaCartPayload({
      data: {
        items: [{ productId: 'p', quantity: 1 }],
        bundles: [{ bundleId: 'b', quantity: 2 }],
      },
    });
    expect(out?.items).toHaveLength(1);
    expect(out?.bundles).toHaveLength(1);
  });

  it('still rejects an empty cart with no bundles either (old-shaped token, or a store without bundles)', () => {
    expect(parseWaCartPayload({ data: { items: [] } })).toBeNull();
    expect(parseWaCartPayload({ data: { items: [], bundles: [] } })).toBeNull();
  });

  it('tolerates a non-array bundles field by dropping it, rather than rejecting the whole payload', () => {
    const out = parseWaCartPayload({
      data: { items: [{ productId: 'p', quantity: 1 }], bundles: 'nope' },
    });
    expect(out).not.toBeNull();
    expect(out?.bundles).toBeUndefined();
  });
});

describe('isRedeemableItem', () => {
  it('requires a product id and a positive quantity', () => {
    expect(isRedeemableItem({ productId: 'p', quantity: 1 })).toBe(true);
    expect(isRedeemableItem({ productId: 'p', quantity: 5 })).toBe(true);
  });

  it('rejects anything that could not be added', () => {
    expect(isRedeemableItem({ quantity: 1 })).toBe(false);
    expect(isRedeemableItem({ productId: '', quantity: 1 })).toBe(false);
    expect(isRedeemableItem({ productId: 'p' })).toBe(false);
    expect(isRedeemableItem({ productId: 'p', quantity: 0 })).toBe(false);
    expect(isRedeemableItem({ productId: 'p', quantity: -1 })).toBe(false);
  });
});

describe('isRedeemableBundle', () => {
  it('requires a bundle id and a positive quantity', () => {
    expect(isRedeemableBundle({ bundleId: 'b', quantity: 1 })).toBe(true);
    expect(isRedeemableBundle({ bundleId: 'b', quantity: 3 })).toBe(true);
  });

  it('rejects anything that could not be added', () => {
    expect(isRedeemableBundle({ quantity: 1 })).toBe(false);
    expect(isRedeemableBundle({ bundleId: '', quantity: 1 })).toBe(false);
    expect(isRedeemableBundle({ bundleId: 'b' })).toBe(false);
    expect(isRedeemableBundle({ bundleId: 'b', quantity: 0 })).toBe(false);
    expect(isRedeemableBundle({ bundleId: 'b', quantity: -1 })).toBe(false);
  });
});

describe('hydrateBundles — the WaTokenHydrator bundle-add loop', () => {
  it('calls the add path once per redeemable entry, in order', async () => {
    const calls: Array<[string, number]> = [];
    const addBundle = vi.fn(async (bundleId: string, quantity: number) => {
      calls.push([bundleId, quantity]);
      return { success: true };
    });

    const anyAdded = await hydrateBundles(
      [
        { bundleId: 'b1', quantity: 1 },
        { bundleId: 'b2', quantity: 3 },
      ],
      addBundle
    );

    expect(addBundle).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([
      ['b1', 1],
      ['b2', 3],
    ]);
    expect(anyAdded).toBe(true);
  });

  it('skips an unredeemable entry without calling the add path for it', async () => {
    const addBundle = vi.fn(async () => ({ success: true }));

    await hydrateBundles(
      [
        { bundleId: 'b1', quantity: 1 },
        { quantity: 1 }, // no bundleId
        { bundleId: 'b2', quantity: 0 }, // zero quantity
      ],
      addBundle
    );

    expect(addBundle).toHaveBeenCalledTimes(1);
    expect(addBundle).toHaveBeenCalledWith('b1', 1);
  });

  it('reports a failed add via onFailure and does not count it toward anyAdded', async () => {
    const addBundle = vi.fn(async () => ({ success: false, error: 'bundle_not_purchasable' }));
    const onFailure = vi.fn();

    const anyAdded = await hydrateBundles([{ bundleId: 'b1', quantity: 1 }], addBundle, onFailure);

    expect(anyAdded).toBe(false);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith('b1', 'bundle_not_purchasable');
  });

  it('a mix of a successful and a failed entry still reports anyAdded true', async () => {
    const addBundle = vi
      .fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'insufficient_stock' });
    const onFailure = vi.fn();

    const anyAdded = await hydrateBundles(
      [
        { bundleId: 'b1', quantity: 1 },
        { bundleId: 'b2', quantity: 5 },
      ],
      addBundle,
      onFailure
    );

    expect(anyAdded).toBe(true);
    expect(onFailure).toHaveBeenCalledWith('b2', 'insufficient_stock');
  });

  it('an empty bundle list never calls the add path', async () => {
    const addBundle = vi.fn();
    const anyAdded = await hydrateBundles([], addBundle);
    expect(addBundle).not.toHaveBeenCalled();
    expect(anyAdded).toBe(false);
  });
});

describe('urlWithoutToken', () => {
  it('strips the token so a refresh cannot re-redeem', () => {
    expect(urlWithoutToken('https://s.com/checkout?waToken=abc')).toBe('/checkout');
  });

  it('preserves other query params', () => {
    expect(urlWithoutToken('https://s.com/checkout?waToken=abc&step=2')).toBe('/checkout?step=2');
  });

  it('is a no-op when the token is absent', () => {
    expect(urlWithoutToken('https://s.com/checkout?step=2')).toBe('/checkout?step=2');
  });
});
