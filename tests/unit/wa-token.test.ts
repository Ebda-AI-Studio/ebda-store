import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  sessionGet,
  sessionSet,
  parseWaCartPayload,
  isRedeemableItem,
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
