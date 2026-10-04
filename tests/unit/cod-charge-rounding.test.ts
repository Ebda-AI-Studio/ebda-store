/**
 * Review Focus 2 (SP6a): EGP rounding to the piastre for the COD fee, with the
 * replay guard and the wallet split. Integer piastres only; the percentage rounds
 * HALF UP; a replayed create never stacks the fee.
 */
import { describe, it, expect } from 'vitest';
import { computeCodCharge } from '@api/services/payment-providers/cod.provider';

const charge = (over: Partial<Parameters<typeof computeCodCharge>[0]> = {}) =>
  computeCodCharge({
    orderTotalMinor: 10_000,
    fixedFeeMinor: 500,
    feeAlreadyApplied: false,
    ...over,
  });

describe('computeCodCharge', () => {
  it('fixed fee only: the courier collects total + fee (parity with FWB)', () => {
    expect(charge()).toEqual({
      feeMinor: 500,
      chargedTotalMinor: 10_500,
      collectMinor: 10_500,
      applyFee: true,
    });
  });

  it('a replayed create does not add the fee again, and collects the same amount', () => {
    const first = charge();
    const replay = charge({ orderTotalMinor: first.chargedTotalMinor, feeAlreadyApplied: true });
    expect(replay.applyFee).toBe(false);
    expect(replay.chargedTotalMinor).toBe(first.chargedTotalMinor);
    expect(replay.collectMinor).toBe(first.collectMinor);
  });

  it('a percentage rounds HALF UP to the piastre: 250 bps of 10 020 = 250.5 -> 251', () => {
    expect(charge({ orderTotalMinor: 10_020, fixedFeeMinor: 0, percentBps: 250 }).feeMinor).toBe(
      251
    );
    // just under the half: 10 019 * 2.5% = 250.475 -> 250
    expect(charge({ orderTotalMinor: 10_019, fixedFeeMinor: 0, percentBps: 250 }).feeMinor).toBe(
      250
    );
  });

  it('fixed + percentage add in integer piastres', () => {
    const c = charge({ orderTotalMinor: 12_345, fixedFeeMinor: 500, percentBps: 150 });
    // 12 345 * 1.5% = 185.175 -> 185
    expect(c.feeMinor).toBe(685);
    expect(c.chargedTotalMinor).toBe(13_030);
  });

  it('the wallet portion is subtracted from what the courier collects, never from the fee', () => {
    const c = charge({ walletMinor: 4_999 });
    expect(c.chargedTotalMinor).toBe(10_500);
    expect(c.collectMinor).toBe(10_500 - 4_999);
  });

  it('no fee configured: nothing is applied', () => {
    expect(charge({ fixedFeeMinor: 0 })).toMatchObject({
      feeMinor: 0,
      applyFee: false,
      collectMinor: 10_000,
    });
  });

  it('every figure is an integer, for awkward totals and rates', () => {
    for (const total of [1, 29, 99, 101, 1_999, 12_345, 99_999, 1_000_001]) {
      for (const bps of [0, 1, 50, 125, 333, 999]) {
        const c = charge({ orderTotalMinor: total, fixedFeeMinor: 75, percentBps: bps });
        for (const n of Object.values(c)) {
          if (typeof n === 'number') expect(Number.isInteger(n)).toBe(true);
        }
        expect(c.chargedTotalMinor).toBe(total + c.feeMinor);
      }
    }
  });
});
