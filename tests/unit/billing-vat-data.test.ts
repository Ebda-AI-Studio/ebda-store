/**
 * FOLD-VAT (data side of TAX-1): the charge of Ebda's own subscription invoice with the platform VAT switch OFF
 * (the default) equals the plan price exactly, and ON at 14% computes net / VAT / gross in piastres, half up.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@api/services/platform-vat.service', () => ({ getPlatformVat: vi.fn() }));
const { PLATFORM_VAT_OFF, subscriptionChargeAmount, toChargeVat } =
  await import('@api/services/billing/charge-amount');
import { DEFAULT_PLATFORM_VAT } from '@ebda/shared';

describe('subscription invoice VAT', () => {
  it('the shipped default is OFF and leaves every total exactly the plan price', () => {
    expect(DEFAULT_PLATFORM_VAT.enabled).toBe(false);
    for (const price of [0, 1, 29900, 149900, 14999]) {
      expect(subscriptionChargeAmount(price, toChargeVat(DEFAULT_PLATFORM_VAT))).toEqual({
        totalMinor: price,
        netMinor: price,
        vatMinor: 0,
        vat: null,
      });
      expect(subscriptionChargeAmount(price, PLATFORM_VAT_OFF).totalMinor).toBe(price);
    }
  });

  it('ON at 14% exclusive: 149.99 EGP -> VAT 21.00 (20.9986 rounds up), gross 170.99', () => {
    const a = subscriptionChargeAmount(14999, {
      enabled: true,
      rateBps: 1400,
      mode: 'exclusive',
      trn: '123456789',
    });
    expect([a.netMinor, a.vatMinor, a.totalMinor]).toEqual([14999, 2100, 17099]);
    expect(a.vat).toMatchObject({ rateBps: 1400, trn: '123456789' });
  });

  it('half-up: 0.25 EGP -> 3.5 piastres rounds to 4; 0.01 EGP -> 0.14 rounds to 0', () => {
    const on = { enabled: true, rateBps: 1400, mode: 'exclusive' as const };
    expect(subscriptionChargeAmount(25, on).vatMinor).toBe(4);
    expect(subscriptionChargeAmount(1, on).vatMinor).toBe(0);
  });

  it('ON inclusive: the price is the gross; net + VAT = gross exactly', () => {
    const a = subscriptionChargeAmount(11400, { enabled: true, rateBps: 1400, mode: 'inclusive' });
    expect([a.netMinor, a.vatMinor, a.totalMinor]).toEqual([10000, 1400, 11400]);
  });
});
