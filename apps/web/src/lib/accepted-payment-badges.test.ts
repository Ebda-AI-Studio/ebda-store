/**
 * Bug: "A COD-only store (no card payment configured) still shows card-brand
 * logos somewhere in checkout/storefront." The cart page's "We Accept" row
 * fell back to a hardcoded `['Visa', 'Mastercard', 'Meeza', 'Fawry']` list
 * whenever the merchant hadn't set `acceptedPaymentMethods` — true for most
 * stores. `deriveAcceptedPaymentBadges` replaces that guess with the real
 * `/payments/config` response.
 */
import { describe, it, expect } from 'vitest';
import { deriveAcceptedPaymentBadges } from './accepted-payment-badges';

describe('deriveAcceptedPaymentBadges', () => {
  it('a COD-only store (no online providers) shows ONLY Cash on Delivery — no card marks', () => {
    const badges = deriveAcceptedPaymentBadges({
      providers: [],
      cod: { displayName: 'Cash on Delivery', displayNameAr: 'الدفع عند الاستلام' },
    });
    expect(badges).toEqual([{ label: 'Cash on Delivery', labelAr: 'الدفع عند الاستلام' }]);
  });

  it('a COD + InstaPay store (still no card gateway) shows neither Visa nor Mastercard', () => {
    const badges = deriveAcceptedPaymentBadges({
      providers: [],
      cod: { displayName: 'Cash on Delivery', displayNameAr: 'الدفع عند الاستلام' },
      instapay: { displayName: 'InstaPay', displayNameAr: 'إنستاباي' },
    });
    expect(badges.map(b => b.label)).toEqual(['Cash on Delivery', 'InstaPay']);
    expect(badges.some(b => /visa|mastercard|meeza/i.test(b.label))).toBe(false);
  });

  it('a store with Paymob configured shows a Card badge', () => {
    const badges = deriveAcceptedPaymentBadges({
      providers: ['paymob'],
      cod: { displayName: 'Cash on Delivery' },
    });
    expect(badges.map(b => b.label)).toEqual(['Card', 'Cash on Delivery']);
  });

  it('a store with Kashier configured shows a Card badge too', () => {
    const badges = deriveAcceptedPaymentBadges({ providers: ['kashier'] });
    expect(badges.map(b => b.label)).toEqual(['Card']);
  });

  it('Fawry gets its own "Pay at Fawry" badge, distinct from a card gateway', () => {
    const badges = deriveAcceptedPaymentBadges({ providers: ['fawry'] });
    expect(badges.map(b => b.label)).toEqual(['Pay at Fawry']);
  });

  it('no providers and no cod/instapay configured yields an empty list (never a guess)', () => {
    expect(deriveAcceptedPaymentBadges({ providers: [] })).toEqual([]);
    expect(deriveAcceptedPaymentBadges({})).toEqual([]);
  });

  it('tolerates a malformed providers field instead of throwing', () => {
    expect(deriveAcceptedPaymentBadges({ providers: 'paymob' as never })).toEqual([]);
  });
});
