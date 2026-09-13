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

/**
 * `BUNDLE_PRICE_NOT_ALLOCATABLE` — the bundle's fixed price can no longer be
 * split exactly across its components, because a component's price moved after
 * the bundle was priced.
 *
 * The SERVER's own message ends "Please try again", which is the one thing that
 * cannot work: the allocation fails identically until the merchant re-prices
 * the bundle. Before this the code was unmapped entirely and fell to the
 * generic "something went wrong… please try again" — the same advice, twice
 * over.
 */
describe('checkoutBundleErrorCopy — BUNDLE_PRICE_NOT_ALLOCATABLE', () => {
  const raw = '"Eid Gift Box" can no longer be priced exactly at checkout. Please try again.';

  it('names the bundle and asks for removal, not a retry', () => {
    const copy = checkoutBundleErrorCopy('BUNDLE_PRICE_NOT_ALLOCATABLE', raw, t)!;
    expect(copy).toMatch(/Eid Gift Box/);
    expect(copy).toMatch(/remove/i);
    expect(copy).not.toMatch(/try again/i);
  });

  it('still answers when the name cannot be parsed', () => {
    // A message shape change must degrade to generic bundle copy, never to
    // null — null falls through to the checkout's "please try again" default,
    // which is the defect.
    const copy = checkoutBundleErrorCopy('BUNDLE_PRICE_NOT_ALLOCATABLE', 'unexpected shape', t);
    expect(copy).not.toBeNull();
    expect(copy!).toMatch(/bundles in your cart/i);
    expect(copy!).not.toMatch(/try again/i);
  });

  it('has Arabic', () => {
    const ar = (_en: string, arabic: string) => arabic;
    expect(checkoutBundleErrorCopy('BUNDLE_PRICE_NOT_ALLOCATABLE', raw, ar)!).toMatch(/[؀-ۿ]/);
  });

  it('does not fire on an unrelated code', () => {
    expect(checkoutBundleErrorCopy('EMPTY_CART', raw, t)).toBeNull();
  });
});
