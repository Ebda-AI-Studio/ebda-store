import { describe, it, expect } from 'vitest';
import {
  productReturnAdjustment,
  type ReturnLineInput,
  type SnapshotRung,
  type TierLadderSnapshot,
} from '../pricing/return-adjustment';

const snap = (
  rungs: Array<Partial<SnapshotRung> & { minQty: number; priceMinor: number }>,
  groupPercentMinor: number | null = null
): TierLadderSnapshot => ({
  rungs: rungs.map(r => ({ variant: false, group: false, ...r })),
  groupPercentMinor,
});

const line = (o: Partial<ReturnLineInput> = {}): ReturnLineInput => ({
  key: 'a',
  variantId: null,
  quantity: 100,
  paidUnitMinor: 80,
  listMinor: 100,
  priceSource: 'tier',
  tierMinQty: 100,
  ladder: snap([{ minQty: 100, priceMinor: 80 }]),
  returnedBefore: 0,
  returning: 0,
  ...o,
});

/** One line, one item returning `returning` units of it. */
const one = (o: Partial<ReturnLineInput>, retained = 0) => {
  const l = line(o);
  const r = productReturnAdjustment(
    [l],
    [{ key: 'i', lineKey: l.key, returning: l.returning }],
    retained
  );
  return { ...r, item: r.items[0]! };
};

describe('productReturnAdjustment: one line (Rulings B2B-13 / B2B-14)', () => {
  it('buy 100 @ 80, return 90 -> kept 10 reaches no tier: repriced at list, adjustment 200, refund 7000', () => {
    const r = one({ returning: 90 });
    expect(r).toMatchObject({ keptQty: 10, rawAdjustment: 200, applied: 200, shortfall: 0 });
    expect(r.item).toMatchObject({
      standardRefund: 7200,
      adjustment: 200,
      adjustedRefund: 7000,
      keptUnitMinor: 100,
    });
    expect(r.reason).toBe('kept_below_tier');
  });
  it('ladder 50+ at 90 and 100+ at 80, return 40 -> kept 60 reaches 50+: repriced at 90, adjustment 600', () => {
    const r = one({
      ladder: snap([
        { minQty: 50, priceMinor: 90 },
        { minQty: 100, priceMinor: 80 },
      ]),
      returning: 40,
    });
    expect(r.item).toMatchObject({ keptUnitMinor: 90, adjustment: 600, adjustedRefund: 2600 });
  });
  it('return 1 of 100 with a 50+ tier at 90: raw 990 > standard 80, the refund floors at 0 and the shortfall 910 is reported', () => {
    const r = one({
      ladder: snap([
        { minQty: 50, priceMinor: 90 },
        { minQty: 100, priceMinor: 80 },
      ]),
      returning: 1,
    });
    expect(r).toMatchObject({ rawAdjustment: 990, applied: 80, shortfall: 910 });
    expect(r.item).toMatchObject({ standardRefund: 80, adjustment: 80, adjustedRefund: 0 });
  });
  it('a kept quantity below every rung falls back to list', () => {
    const r = one({
      ladder: snap([
        { minQty: 50, priceMinor: 90 },
        { minQty: 100, priceMinor: 80 },
      ]),
      returning: 70,
    });
    expect(r.item.keptUnitMinor).toBe(100);
    expect(r.applied).toBe((100 - 80) * 30);
  });
  it('returning every unit is not adjusted; kept exactly at the threshold is not adjusted', () => {
    expect(one({ returning: 100 })).toMatchObject({ applied: 0, reason: 'none' });
    expect(one({ quantity: 110, returning: 10 }).item).toMatchObject({
      adjustment: 0,
      adjustedRefund: 800,
    });
  });
  it('cumulative: 10 then 80 more telescopes to the single-shot raw value for the same final kept', () => {
    const first = one({ returning: 10 });
    const second = one({ returnedBefore: 10, returning: 80 });
    const single = one({ returning: 90 });
    expect(first.rawAdjustment + second.rawAdjustment).toBe(single.rawAdjustment);
  });
  it('returning the last units releases the earlier clawback, never more than was retained', () => {
    const last = one({ returnedBefore: 90, returning: 10 }, 200);
    expect(last).toMatchObject({ rawAdjustment: -200, applied: -200, reason: 'released' });
    expect(last.item.adjustedRefund).toBe(800 + 200);
    // only 50 was actually retained earlier (an override, or the floor): only 50 comes back
    expect(one({ returnedBefore: 90, returning: 10 }, 50).applied).toBe(-50);
    // nothing retained: a release clamps to 0 and is NOT reported as a release (review minor 3)
    expect(one({ returnedBefore: 90, returning: 10 }, 0)).toMatchObject({
      applied: 0,
      reason: 'none',
    });
  });
  it.each([
    ['group percent', { priceSource: 'group' as const }],
    ['base', { priceSource: 'base' as const }],
    ['no snapshot (null list)', { listMinor: null }],
    ['no ladder', { ladder: null }],
    ['no tier threshold', { tierMinQty: null }],
    ['paid == list', { paidUnitMinor: 100, ladder: snap([{ minQty: 100, priceMinor: 100 }]) }],
  ])('%s -> never adjusted', (_n, o) => {
    const r = one({ ...o, returning: 90 });
    expect(r.applied).toBe(0);
    expect(r.item.adjustedRefund).toBe(r.item.standardRefund);
  });
  it('rejects non-integers and over-returns loudly', () => {
    expect(() => one({ paidUnitMinor: 80.5 })).toThrow(RangeError);
    expect(() => one({ returning: 101 })).toThrow(RangeError);
    expect(() => one({ returnedBefore: 95, returning: 6 })).toThrow(RangeError);
  });
});

describe('Ruling B2B-17: eligibility is judged on the PRODUCT (and variant) aggregate, the way the tier was awarded', () => {
  // list 100, public product-level tier 10+ @ 80
  const ladder = snap([{ minQty: 10, priceMinor: 80 }]);
  const S = (o: Partial<ReturnLineInput> = {}) =>
    line({ key: 'S', variantId: 'vS', quantity: 6, tierMinQty: 10, ladder, ...o });
  const M = (o: Partial<ReturnLineInput> = {}) =>
    line({ key: 'M', variantId: 'vM', quantity: 6, tierMinQty: 10, ladder, ...o });

  it('6 S + 6 M @ 80 (12 >= 10), return all 6 S: the 6 M kept are repriced at 100, adjustment 120, S refunds 360', () => {
    const r = productReturnAdjustment(
      [S({ returning: 6 }), M()],
      [{ key: 'ri-S', lineKey: 'S', returning: 6 }],
      0
    );
    expect(r).toMatchObject({ keptQty: 6, rawAdjustment: 120, applied: 120, shortfall: 0 });
    expect(r.items).toEqual([
      {
        key: 'ri-S',
        standardRefund: 480,
        adjustment: 120,
        adjustedRefund: 360,
        keptUnitMinor: 100,
      },
    ]);
    // the per-line view (what shipped before this ruling) saw nothing to claw back on S and never looked at M
    const perLine = productReturnAdjustment(
      [S({ returning: 6 })],
      [{ key: 'ri-S', lineKey: 'S', returning: 6 }],
      0
    );
    expect(perLine.applied).toBe(0);
  });

  it('the split-line exploit: one variant as two note-lines 5 + 5 (tier 10+), return one whole line -> adjustment 100', () => {
    const a = line({
      key: 'n1',
      variantId: 'v',
      quantity: 5,
      tierMinQty: 10,
      ladder,
      returning: 5,
    });
    const b = line({ key: 'n2', variantId: 'v', quantity: 5, tierMinQty: 10, ladder });
    const r = productReturnAdjustment([a, b], [{ key: 'ri', lineKey: 'n1', returning: 5 }], 0);
    expect(r).toMatchObject({ keptQty: 5, applied: 100 });
    expect(r.items[0]).toMatchObject({ standardRefund: 400, adjustedRefund: 300 });
  });

  it('mixed: return 3 S + 2 M of 6 + 6 -> kept 7 < 10, clawback 140 spread by standard refund 240 : 160 -> 84 + 56', () => {
    const r = productReturnAdjustment(
      [S({ returning: 3 }), M({ returning: 2 })],
      [
        { key: 'ri-S', lineKey: 'S', returning: 3 },
        { key: 'ri-M', lineKey: 'M', returning: 2 },
      ],
      0
    );
    expect(r.applied).toBe(140);
    expect(r.items.map(i => i.adjustment)).toEqual([84, 56]);
    expect(r.items.reduce((n, i) => n + i.adjustment, 0)).toBe(r.applied);
  });

  it('then the rest comes back: the release is bounded by what the product retained, wherever it was booked', () => {
    // first return took 6 S and retained 120 (booked on S); now all 6 M come back: kept 0, release 120 on the M item
    const r = productReturnAdjustment(
      [S({ returnedBefore: 6 }), M({ returning: 6 })],
      [{ key: 'ri-M', lineKey: 'M', returning: 6 }],
      120
    );
    expect(r).toMatchObject({ rawAdjustment: -120, applied: -120, reason: 'released' });
    expect(r.items[0]).toMatchObject({ standardRefund: 480, adjustedRefund: 600 });
    // 360 + 600 = 960 = what the 12 units were paid: nothing more, nothing less
  });

  it('a variant-level tier is judged on the VARIANT kept quantity: S keeps its 5+ break when only M comes back', () => {
    const vLadder = snap([
      { minQty: 10, priceMinor: 80 },
      { minQty: 5, priceMinor: 78, variant: true },
    ]);
    const s = line({
      key: 'S',
      variantId: 'vS',
      quantity: 6,
      paidUnitMinor: 78,
      tierMinQty: 5,
      ladder: vLadder,
    });
    const m = line({
      key: 'M',
      variantId: 'vM',
      quantity: 6,
      tierMinQty: 10,
      ladder: snap([{ minQty: 10, priceMinor: 80 }]),
      returning: 6,
    });
    const r = productReturnAdjustment([s, m], [{ key: 'ri', lineKey: 'M', returning: 6 }], 0);
    expect(r.applied).toBe(0); // S: variant kept 6 >= 5 at 78; M: nothing kept
    const r2 = productReturnAdjustment(
      [{ ...s, returning: 2 }, m],
      [
        { key: 'ri-S', lineKey: 'S', returning: 2 },
        { key: 'ri-M', lineKey: 'M', returning: 6 },
      ],
      0
    );
    expect(r2.applied).toBe((100 - 78) * 4); // S kept 4 < 5 and product kept 4 < 10: list
  });

  it('bundle-free order of two products: only the product passed in is judged (the caller scopes by product)', () => {
    const r = productReturnAdjustment(
      [S({ returning: 1 })],
      [{ key: 'x', lineKey: 'S', returning: 1 }],
      0
    );
    expect(r.keptQty).toBe(5);
  });

  it('allocation is exact integers by largest remainder', () => {
    const lines = ['a', 'b', 'c'].map(k =>
      line({
        key: k,
        variantId: k,
        quantity: 4,
        paidUnitMinor: 80,
        tierMinQty: 12,
        ladder: snap([{ minQty: 12, priceMinor: 80 }]),
        returning: 1,
      })
    );
    const r = productReturnAdjustment(
      lines,
      lines.map(l => ({ key: l.key, lineKey: l.key, returning: 1 })),
      0
    );
    expect(r.applied).toBe(20 * 9); // kept 9 of 12
    expect(r.items.map(i => i.adjustment)).toEqual([60, 60, 60]);
    const odd = productReturnAdjustment(
      [
        line({
          key: 'p',
          quantity: 7,
          paidUnitMinor: 70,
          listMinor: 77,
          tierMinQty: 7,
          ladder: snap([{ minQty: 7, priceMinor: 70 }]),
          returning: 3,
        }),
      ],
      [
        { key: 'x', lineKey: 'p', returning: 1 },
        { key: 'y', lineKey: 'p', returning: 2 },
      ],
      0
    );
    expect(odd.applied).toBe(7 * 4);
    expect(odd.items.map(i => i.adjustment)).toEqual([9, 19]); // 28 x 70/210 = 9.33, 28 x 140/210 = 18.67
  });
});

describe('Ruling B2B-18: kept units keep the buyer full sale-time entitlement, never bare list', () => {
  it('group 10% off (90) and a group tier 10+ @ 80: buy 10, return 5 -> kept 5 repriced at 90, refund 350', () => {
    const r = one({
      quantity: 10,
      tierMinQty: 10,
      ladder: snap([{ minQty: 10, priceMinor: 80, group: true }], 90),
      returning: 5,
    });
    expect(r.item).toMatchObject({
      standardRefund: 400,
      adjustment: 50,
      adjustedRefund: 350,
      keptUnitMinor: 90,
    });
  });
  it('a public break still reached beats the group percent when cheaper; the cheapest of the audiences wins', () => {
    const ladder = snap(
      [
        { minQty: 5, priceMinor: 85 },
        { minQty: 10, priceMinor: 80, group: true },
      ],
      90
    );
    expect(one({ quantity: 10, tierMinQty: 10, ladder, returning: 4 }).item.keptUnitMinor).toBe(85);
    expect(one({ quantity: 10, tierMinQty: 10, ladder, returning: 6 }).item.keptUnitMinor).toBe(90);
  });
  it('never reprices kept units BELOW what was paid (a snapshot price under the paid one is ignored)', () => {
    const r = one({
      quantity: 10,
      tierMinQty: 10,
      ladder: snap([{ minQty: 10, priceMinor: 80 }], 70),
      returning: 5,
    });
    expect(r.item).toMatchObject({ keptUnitMinor: 80, adjustment: 0 });
  });
});

describe('property (seeded)', () => {
  it('integers; refunds never negative; a release never exceeds retained; telescoping over two steps; line order irrelevant', () => {
    let seed = 20261021;
    const rnd = (n: number) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed % n;
    };
    for (let t = 0; t < 400; t++) {
      const L = 50 + rnd(500);
      const nLines = 1 + rnd(3);
      const rungs = Array.from({ length: 1 + rnd(3) }, () => ({
        minQty: 2 + rnd(30),
        priceMinor: 1 + rnd(L - 1),
      }));
      const ladder = snap(rungs);
      const lines = Array.from({ length: nLines }, (_, i) => {
        const q = 1 + rnd(20);
        return line({
          key: `l${i}`,
          variantId: `v${rnd(2)}`,
          quantity: q,
          paidUnitMinor: Math.min(...rungs.map(r => r.priceMinor)),
          listMinor: L,
          tierMinQty: 2,
          ladder,
          returning: rnd(q + 1),
        });
      });
      const items = lines
        .filter(l => l.returning > 0)
        .map(l => ({ key: l.key, lineKey: l.key, returning: l.returning }));
      const retained = rnd(500);
      const r = productReturnAdjustment(lines, items, retained);
      for (const it of r.items) {
        expect(Number.isInteger(it.adjustment)).toBe(true);
        expect(it.adjustedRefund).toBeGreaterThanOrEqual(0);
      }
      expect(r.items.reduce((n, i) => n + i.adjustment, 0)).toBe(r.applied);
      expect(r.applied).toBeGreaterThanOrEqual(-retained);
      const rev = productReturnAdjustment([...lines].reverse(), items, retained);
      expect(rev.applied).toBe(r.applied);
      // two steps telescope (raw) to the single shot
      const half = lines.map(l => ({ ...l, returning: Math.floor(l.returning / 2) }));
      const rest = lines.map((l, i) => ({
        ...l,
        returnedBefore: half[i]!.returning,
        returning: l.returning - half[i]!.returning,
      }));
      const a = productReturnAdjustment(half, [], 0);
      const b = productReturnAdjustment(rest, [], 0);
      expect(a.rawAdjustment + b.rawAdjustment).toBe(r.rawAdjustment);
    }
  });
});
