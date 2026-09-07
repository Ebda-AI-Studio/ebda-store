import { describe, it, expect } from 'vitest';
import { classifyBundleCartError, bundleCartErrorCopy } from './bundle-cart-errors';

const t = (en: string, ar: string) => `${en}|${ar}`;

describe('classifyBundleCartError', () => {
  it('classifies the raw "bundle_not_purchasable" string body', () => {
    expect(classifyBundleCartError('bundle_not_purchasable')).toBe('bundle_not_purchasable');
  });

  it('classifies the raw "insufficient_stock" string body', () => {
    expect(classifyBundleCartError('insufficient_stock')).toBe('insufficient_stock');
  });

  it('falls back to "unknown" for an unrelated error object (network/generic failures)', () => {
    expect(classifyBundleCartError({ code: 'NETWORK_ERROR', message: 'Network error' })).toBe(
      'unknown'
    );
  });

  it('falls back to "unknown" for undefined/empty', () => {
    expect(classifyBundleCartError(undefined)).toBe('unknown');
    expect(classifyBundleCartError('')).toBe('unknown');
  });
});

describe('bundleCartErrorCopy', () => {
  it('gives bundle_not_purchasable its own specific copy, distinct from the generic fallback', () => {
    const specific = bundleCartErrorCopy('bundle_not_purchasable', t);
    const generic = bundleCartErrorCopy('unknown', t);
    expect(specific.title).not.toBe(generic.title);
    expect(specific.message).not.toBe(generic.message);
    expect(specific.title.toLowerCase()).toContain('unavailable');
  });

  it('gives insufficient_stock its own specific copy, distinct from the generic fallback and from bundle_not_purchasable', () => {
    const stock = bundleCartErrorCopy('insufficient_stock', t);
    const notPurchasable = bundleCartErrorCopy('bundle_not_purchasable', t);
    const generic = bundleCartErrorCopy('unknown', t);
    expect(stock.title).not.toBe(generic.title);
    expect(stock.title).not.toBe(notPurchasable.title);
    expect(stock.message.toLowerCase()).toContain('stock');
  });

  it('every branch carries both an English and an Arabic half via t()', () => {
    for (const code of ['bundle_not_purchasable', 'insufficient_stock', 'unknown'] as const) {
      const { title, message } = bundleCartErrorCopy(code, t);
      expect(title.split('|')).toHaveLength(2);
      expect(message.split('|')).toHaveLength(2);
    }
  });
});
