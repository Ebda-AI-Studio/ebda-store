/**
 * Review Focus 2 (SP6a), re-shaped by ruling MONEYB-3: EGP rounding to the
 * piastre for the COD fee, quoted at checkout and frozen at order creation by
 * ONE function (`codFeeForOrder`); `/payments/create` adds nothing and only
 * computes what the courier collects (`codCollectMinor`). Integer piastres
 * only; the percentage rounds HALF UP.
 */
import { describe, it, expect } from 'vitest';
import { codFeeForOrder } from '@force/shared';
import { codCollectMinor, codFeeConfigFromRow } from '@api/services/payment-providers/cod.provider';

const fee = (goods: number, cfg: { fixedFee?: number; percentBps?: number }, shipping = 0) =>
  codFeeForOrder({ subtotal: goods, discount: 0, shipping }, cfg);

describe('codFeeForOrder (the quoted = frozen fee)', () => {
  it('fixed fee only', () => {
    expect(fee(10_000, { fixedFee: 500 })).toBe(500);
  });

  it('a percentage rounds HALF UP to the piastre: 250 bps of 10 020 = 250.5 -> 251', () => {
    expect(fee(10_020, { percentBps: 250 })).toBe(251);
    // just under the half: 10 019 * 2.5% = 250.475 -> 250
    expect(fee(10_019, { percentBps: 250 })).toBe(250);
  });

  it('fixed + percentage add in integer piastres; the percentage covers shipping too', () => {
    // (12 000 + 345) * 1.5% = 185.175 -> 185
    expect(fee(12_000, { fixedFee: 500, percentBps: 150 }, 345)).toBe(685);
  });

  it('no fee configured: nothing is charged', () => {
    expect(fee(10_000, {})).toBe(0);
  });

  it('every figure is an integer, for awkward totals and rates', () => {
    for (const total of [1, 29, 99, 101, 1_999, 12_345, 99_999, 1_000_001]) {
      for (const bps of [0, 1, 50, 125, 333, 999]) {
        const f = fee(total, { fixedFee: 75, percentBps: bps });
        expect(Number.isInteger(f)).toBe(true);
        expect(f).toBeGreaterThanOrEqual(75);
      }
    }
  });
});

describe('codFeeConfigFromRow', () => {
  it('reads the fixed fee column and settings.percentBps; garbage reads as 0', () => {
    expect(codFeeConfigFromRow({ fixedFee: '500', settings: { percentBps: 200 } })).toEqual({
      fixedFee: 500,
      percentBps: 200,
    });
    expect(codFeeConfigFromRow({ fixedFee: null, settings: { percentBps: 'x' } })).toEqual({
      fixedFee: 0,
      percentBps: 0,
    });
  });
});

describe('codCollectMinor (what the courier collects)', () => {
  it('the order total (fee already inside) less the wallet portion, never negative', () => {
    expect(codCollectMinor(10_500)).toBe(10_500);
    expect(codCollectMinor(10_500, 4_999)).toBe(10_500 - 4_999);
    expect(codCollectMinor(1_000, 5_000)).toBe(0);
  });
});
