import { describe, it, expect } from 'vitest';
import { checkoutBundleErrorCopy } from './checkout-bundle-errors';

const t = (en: string, ar: string) => `${en}|${ar}`;

describe('checkoutBundleErrorCopy', () => {
  it('names the bundle for BUNDLE_NOT_PURCHASABLE, extracted from the API message', () => {
    const msg = checkoutBundleErrorCopy(
      'BUNDLE_NOT_PURCHASABLE',
      '"Weekend Grill Box" is no longer available. Remove it from your cart and try again.',
      t
    );
    expect(msg).not.toBeNull();
    expect(msg).toContain('Weekend Grill Box');
    // Both locale halves present via the t() mock.
    expect(msg!.split('|')).toHaveLength(2);
    expect(msg!.split('|')[1]).toContain('Weekend Grill Box');
  });

  it('falls back to a generic-but-still-bundle-specific message for BUNDLE_NOT_PURCHASABLE when the name cannot be parsed', () => {
    const msg = checkoutBundleErrorCopy('BUNDLE_NOT_PURCHASABLE', 'unexpected shape', t);
    expect(msg).not.toBeNull();
    expect(msg!.toLowerCase()).toContain('bundle');
    expect(msg!.split('|')).toHaveLength(2);
  });

  it('names the bundle for an INSUFFICIENT_INVENTORY failure caused by a bundle component', () => {
    const msg = checkoutBundleErrorCopy(
      'INSUFFICIENT_INVENTORY',
      'Not enough inventory for Olive Oil 1L (component of "Weekend Grill Box")',
      t
    );
    expect(msg).not.toBeNull();
    expect(msg).toContain('Weekend Grill Box');
    expect(msg!.split('|')).toHaveLength(2);
  });

  it('returns null for a PLAIN PRODUCT INSUFFICIENT_INVENTORY failure — never mis-fires on the same code', () => {
    const msg = checkoutBundleErrorCopy(
      'INSUFFICIENT_INVENTORY',
      'Not enough inventory for Olive Oil 1L',
      t
    );
    expect(msg).toBeNull();
  });

  it('returns null for every other error code (falls through to existing generic handling)', () => {
    expect(checkoutBundleErrorCopy('EMPTY_CART', 'Cart is empty', t)).toBeNull();
    expect(checkoutBundleErrorCopy('VALIDATION_ERROR', 'invalid', t)).toBeNull();
    expect(checkoutBundleErrorCopy('COD_NOT_AVAILABLE', '', t)).toBeNull();
  });
});
