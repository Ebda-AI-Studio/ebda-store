/**
 * Ruling GEIDEA-2: checkout never offers a provider Ebda cannot confirm. The invariant is stated
 * over EVERY catalog gateway, so a future adapter with no confirmation path cannot slip through.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from '@ebda/shared';
import { isOfferableAtCheckout } from '@api/services/payment-providers/provider-gate';
import { getProviderV2 } from '@api/services/payment-providers/registry';

afterEach(() => {
  delete process.env.CHECKOUT_UNCONFIRMED_PROVIDERS;
});

const gateways = PROVIDER_CATALOG.filter(p => p.kind === 'payments' && !p.manual);

describe('checkout offers only providers Ebda can confirm', () => {
  it('every gateway without a verifiable webhook AND without a remote status API is hidden', () => {
    for (const g of gateways) {
      const caps = getProviderV2(g.code)!.capabilities;
      const confirmable = caps.webhooks || caps.remoteStatus;
      expect(isOfferableAtCheckout(g.code, 'store-1'), g.code).toBe(confirmable);
    }
  });

  it('geidea is hidden today, and the confirmable gateways and manual methods are offered', () => {
    expect(isOfferableAtCheckout('geidea', 'store-1')).toBe(false);
    for (const code of ['paymob', 'kashier', 'fawry', 'cod', 'instapay']) {
      expect(isOfferableAtCheckout(code, 'store-1'), code).toBe(true);
    }
    expect(isOfferableAtCheckout('nope', 'store-1')).toBe(false);
  });

  it('the operator flag enables it for the named store only', () => {
    process.env.CHECKOUT_UNCONFIRMED_PROVIDERS = 'geidea:store-7';
    expect(isOfferableAtCheckout('geidea', 'store-7')).toBe(true);
    expect(isOfferableAtCheckout('geidea', 'store-8')).toBe(false);
    expect(isOfferableAtCheckout('geidea', null)).toBe(false);
    process.env.CHECKOUT_UNCONFIRMED_PROVIDERS = 'geidea:*';
    expect(isOfferableAtCheckout('geidea', 'store-8')).toBe(true);
    // the flag never widens another provider
    process.env.CHECKOUT_UNCONFIRMED_PROVIDERS = 'geidea:*';
    expect(isOfferableAtCheckout('nope', 'store-8')).toBe(false);
  });
});
