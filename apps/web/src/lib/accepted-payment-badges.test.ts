/**
 * Bug: "A COD-only store (no card payment configured) still shows card-brand
 * logos somewhere in checkout/storefront." The cart page's "We Accept" row
 * fell back to a hardcoded `['Visa', 'Mastercard', 'Meeza', 'Fawry']` list
 * whenever the merchant hadn't set `acceptedPaymentMethods` — true for most
 * stores. `deriveAcceptedPaymentBadges` replaces that guess with the real
 * `/payments/config` response, reading the SPECIFIC enabled method codes
 * (`config.methods`) rather than just which providers are turned on.
 */
import { describe, it, expect } from 'vitest';
import { deriveAcceptedPaymentBadges } from './accepted-payment-badges';

describe('deriveAcceptedPaymentBadges', () => {
  it('a COD-only store (no online providers) shows ONLY Cash on Delivery — no card marks', () => {
    const badges = deriveAcceptedPaymentBadges({
      methods: {},
      cod: { displayName: 'Cash on Delivery', displayNameAr: 'الدفع عند الاستلام' },
    });
    expect(badges).toEqual([{ label: 'Cash on Delivery', labelAr: 'الدفع عند الاستلام' }]);
  });

  it('a COD + InstaPay store (still no card gateway) shows neither Visa nor Mastercard', () => {
    const badges = deriveAcceptedPaymentBadges({
      methods: {},
      cod: { displayName: 'Cash on Delivery', displayNameAr: 'الدفع عند الاستلام' },
      instapay: { displayName: 'InstaPay', displayNameAr: 'إنستاباي' },
    });
    expect(badges.map(b => b.label)).toEqual(['Cash on Delivery', 'InstaPay']);
    expect(badges.some(b => /visa|mastercard|meeza/i.test(b.label))).toBe(false);
  });

  it('Paymob with ONLY the Meeza method enabled shows a Meeza badge, not a generic Card badge', () => {
    const badges = deriveAcceptedPaymentBadges({
      methods: { paymob: [{ code: 'meeza', name: 'Meeza', nameAr: 'ميزة' }] },
    });
    expect(badges.map(b => b.label)).toEqual(['Meeza']);
  });

  it('Paymob with the card method enabled shows a Card badge', () => {
    const badges = deriveAcceptedPaymentBadges({
      methods: { paymob: [{ code: 'card', name: 'Card', nameAr: 'بطاقة' }] },
      cod: { displayName: 'Cash on Delivery' },
    });
    expect(badges.map(b => b.label)).toEqual(['Card', 'Cash on Delivery']);
  });

  it('Fawry gets its own "Pay at Fawry" badge from the payatfawry method code', () => {
    const badges = deriveAcceptedPaymentBadges({
      methods: { fawry: [{ code: 'payatfawry' }] },
    });
    expect(badges.map(b => b.label)).toEqual(['Pay at Fawry']);
  });

  it('the same method code enabled on two providers only shows once', () => {
    const badges = deriveAcceptedPaymentBadges({
      methods: { paymob: [{ code: 'card' }], kashier: [{ code: 'card' }] },
    });
    expect(badges.map(b => b.label)).toEqual(['Card']);
  });

  it('an unrecognised future method code is never shown with a guessed label', () => {
    const badges = deriveAcceptedPaymentBadges({
      methods: { paymob: [{ code: 'some_new_method' }] },
    });
    expect(badges).toEqual([]);
  });

  it('no methods and no cod/instapay configured yields an empty list (never a guess)', () => {
    expect(deriveAcceptedPaymentBadges({ methods: {} })).toEqual([]);
    expect(deriveAcceptedPaymentBadges({})).toEqual([]);
  });

  it('tolerates a malformed methods field instead of throwing', () => {
    expect(deriveAcceptedPaymentBadges({ methods: 'paymob' as never })).toEqual([]);
    expect(deriveAcceptedPaymentBadges({ methods: { paymob: 'card' as never } })).toEqual([]);
  });
});
