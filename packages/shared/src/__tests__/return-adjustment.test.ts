import { describe, it, expect } from 'vitest';
import { returnAdjustment, type ReturnAdjustmentInput } from '../pricing/return-adjustment';

const base: ReturnAdjustmentInput = {
  quantity: 100,
  paidUnitMinor: 80,
  listMinor: 100,
  priceSource: 'tier',
  tierMinQty: 100,
  ladder: [{ minQty: 100, priceMinor: 80 }],
  returnedBefore: 0,
  returning: 0,
};
const run = (o: Partial<ReturnAdjustmentInput>) => returnAdjustment({ ...base, ...o });

describe('returnAdjustment (Ruling B2B-10 / B2B-13)', () => {
  it('buy 100 @ 80, return 90 -> kept 10 reaches no tier: repriced at list, adjustment 200, refund 7000', () => {
    const r = run({ returning: 90 });
    expect(r).toMatchObject({
      keptQty: 10,
      standardRefund: 7200,
      adjustment: 200,
      adjustedRefund: 7000,
      shortfall: 0,
      keptUnitMinor: 100,
    });
  });
  it('B2B-13: ladder 50+ at 90 and 100+ at 80, return 40 -> kept 60 reaches 50+: repriced at 90, adjustment 600, refund 2600', () => {
    const r = run({
      ladder: [
        { minQty: 50, priceMinor: 90 },
        { minQty: 100, priceMinor: 80 },
      ],
      returning: 40,
    });
    expect(r).toMatchObject({
      keptQty: 60,
      keptUnitMinor: 90,
      adjustment: 600,
      adjustedRefund: 2600,
    });
  });
  it('return 1 of 100 with a 50+ tier at 90: adjustment 990 > standard 80, the refund floors at 0 and the shortfall 910 is reported', () => {
    const r = run({
      ladder: [
        { minQty: 50, priceMinor: 90 },
        { minQty: 100, priceMinor: 80 },
      ],
      returning: 1,
    });
    expect(r).toMatchObject({
      adjustment: 990,
      standardRefund: 80,
      adjustedRefund: 0,
      shortfall: 910,
    });
  });
  it('a kept quantity below every rung falls back to list', () => {
    const r = run({
      ladder: [
        { minQty: 50, priceMinor: 90 },
        { minQty: 100, priceMinor: 80 },
      ],
      returning: 70,
    });
    expect(r.keptUnitMinor).toBe(100);
    expect(r.adjustment).toBe((100 - 80) * 30);
  });
  it('returning every unit is not adjusted; kept exactly at the threshold is not adjusted', () => {
    expect(run({ returning: 100 })).toMatchObject({
      adjustment: 0,
      adjustedRefund: 8000,
      reason: 'none',
    });
    expect(run({ quantity: 100, returning: 0 }).adjustment).toBe(0);
    expect(run({ quantity: 110, tierMinQty: 100, returning: 10 })).toMatchObject({
      adjustment: 0,
      adjustedRefund: 800,
    });
  });
  it('cumulative: 10 then 80 more telescopes to the single-shot value for the same final kept', () => {
    const first = run({ returning: 10 });
    const second = run({ returnedBefore: 10, returning: 80 });
    const single = run({ returning: 90 });
    expect(first.adjustment + second.adjustment).toBe(single.adjustment);
    expect(first.adjustment).toBe(0 + (100 - 80) * 0 + clawbackOf(90)); // 90 kept < 100: repriced at list
  });
  it('returning the last units releases the earlier clawback (negative adjustment)', () => {
    const first = run({ returning: 90 }); // +200
    const last = run({ returnedBefore: 90, returning: 10 });
    expect(last.adjustment).toBe(-200);
    expect(first.adjustment + last.adjustment).toBe(0);
    expect(last.adjustedRefund).toBe(800 + 200);
  });
  it.each([
    ['group percent', { priceSource: 'group' as const }],
    ['base', { priceSource: 'base' as const }],
    ['no snapshot (null list)', { listMinor: null }],
    ['no ladder', { ladder: null }],
    ['no tier threshold', { tierMinQty: null }],
    [
      'paid == list',
      { paidUnitMinor: 100, listMinor: 100, ladder: [{ minQty: 100, priceMinor: 100 }] },
    ],
  ])('%s -> never adjusted', (_n, o) => {
    const r = run({ ...o, returning: 90 });
    expect(r.adjustment).toBe(0);
    expect(r.adjustedRefund).toBe(r.standardRefund);
  });
  it('rejects non-integers and over-returns loudly', () => {
    expect(() => run({ paidUnitMinor: 80.5 })).toThrow(RangeError);
    expect(() => run({ returning: 101 })).toThrow(RangeError);
    expect(() => run({ returnedBefore: 95, returning: 6 })).toThrow(RangeError);
  });

  it('property (seeded): fresh refund is integer, never negative, never above b*k; the ladder row order does not matter; sequences telescope', () => {
    let seed = 20261021;
    const rnd = (n: number) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed % n;
    };
    for (let t = 0; t < 400; t++) {
      const N = 2 + rnd(200);
      const L = 50 + rnd(500);
      const rungs = Array.from({ length: 1 + rnd(4) }, () => ({
        minQty: 2 + rnd(N),
        priceMinor: 1 + rnd(L - 1),
      }));
      const reached = rungs.filter(r => r.minQty <= N);
      if (reached.length === 0) continue;
      const top = reached.reduce((a, r) => (r.priceMinor < a.priceMinor ? r : a));
      const input = {
        quantity: N,
        paidUnitMinor: top.priceMinor,
        listMinor: L,
        priceSource: 'tier' as const,
        tierMinQty: top.minQty,
        ladder: rungs,
        returnedBefore: 0,
        returning: 1 + rnd(N),
      };
      const r = returnAdjustment(input);
      expect(Number.isInteger(r.adjustedRefund) && Number.isInteger(r.adjustment)).toBe(true);
      expect(r.adjustedRefund).toBeGreaterThanOrEqual(0);
      expect(r.adjustedRefund).toBeLessThanOrEqual(top.priceMinor * input.returning);
      const shuffled = [...rungs].sort(() => rnd(3) - 1);
      expect(returnAdjustment({ ...input, ladder: shuffled })).toEqual(r);
      // two-step sequence telescopes to the single shot
      if (input.returning >= 2) {
        const k1 = 1 + rnd(input.returning - 1);
        const a = returnAdjustment({ ...input, returning: k1 });
        const b2 = returnAdjustment({
          ...input,
          returnedBefore: k1,
          returning: input.returning - k1,
        });
        expect(a.adjustment + b2.adjustment).toBe(r.adjustment);
      }
    }
  });
});

function clawbackOf(kept: number): number {
  return (100 - 80) * kept;
}
