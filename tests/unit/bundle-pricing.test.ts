import { describe, it, expect } from 'vitest';
import {
  computeBundlePrice,
  allocateBundlePrice,
  isAllocatable,
  nearestAllocatablePrice,
  type BundleLine,
} from '@force/shared';

// Ramadan Box: Dates 4.500 x1, Honey 6.000 x1, Nuts 2.000 x2 -> sum 14.500
const BOX: BundleLine[] = [
  { key: 'dates', unitPrice: 4500, quantity: 1 },
  { key: 'honey', unitPrice: 6000, quantity: 1 },
  { key: 'nuts', unitPrice: 2000, quantity: 2 },
];
const SUM = 14500;

describe('computeBundlePrice', () => {
  it('takes fixed_price literally', () => {
    expect(computeBundlePrice(SUM, 'fixed_price', 12000)).toBe(12000);
  });

  it('treats percentage as basis points off the sum', () => {
    // 15% of 14500 = 2175 -> 12325
    expect(computeBundlePrice(SUM, 'percentage', 1500)).toBe(12325);
  });

  it('treats fixed as fils off the sum', () => {
    expect(computeBundlePrice(SUM, 'fixed', 2500)).toBe(12000);
  });

  it('never returns a negative price', () => {
    expect(computeBundlePrice(SUM, 'fixed', 99999)).toBe(0);
  });
});

describe('allocateBundlePrice', () => {
  it('sums to the bundle price EXACTLY (invariant 1)', () => {
    const out = allocateBundlePrice(BOX, 12000);
    expect(out.reduce((s, l) => s + l.totalAllocated, 0)).toBe(12000);
  });

  it('keeps unit x quantity == total on every line (invariant 2)', () => {
    for (const l of allocateBundlePrice(BOX, 12000)) {
      expect(l.unitAllocated * l.quantity).toBe(l.totalAllocated);
    }
  });

  it('matches the worked example in the spec', () => {
    const byKey = Object.fromEntries(
      allocateBundlePrice(BOX, 12000).map(l => [l.key, l.totalAllocated])
    );
    expect(byKey).toEqual({ dates: 3724, honey: 4966, nuts: 3310 });
  });

  it('is deterministic across repeated calls', () => {
    expect(allocateBundlePrice(BOX, 12000)).toEqual(allocateBundlePrice(BOX, 12000));
  });

  it('holds both invariants across many prices (property check)', () => {
    for (let price = 1; price <= SUM; price += 7) {
      if (!isAllocatable(BOX, price)) continue;
      const out = allocateBundlePrice(BOX, price);
      expect(out.reduce((s, l) => s + l.totalAllocated, 0)).toBe(price);
      for (const l of out) expect(l.unitAllocated * l.quantity).toBe(l.totalAllocated);
    }
  });

  it('sums to the price EXACTLY at every integer price, independent of isAllocatable (invariant 1, exhaustive)', () => {
    // BOX contains two quantity=1 lines, so every integer price in
    // [0, SUM] is genuinely allocatable — this is verified independently of
    // isAllocatable() so the check cannot be fooled by a bug that corrupts
    // isAllocatable's own oracle (it calls allocateBundlePrice itself).
    for (let price = 0; price <= SUM; price++) {
      const out = allocateBundlePrice(BOX, price);
      expect(out.reduce((s, l) => s + l.totalAllocated, 0)).toBe(price);
    }
  });

  // RULING T2-c: the reviewer's own reproduction (task-2-review.md) of the
  // per-unit stepping cliff — one huge-quantity line paired with one
  // tiny-quantity line. The reviewer measured 142,857,142 outer-loop
  // iterations (~1.1s) for a NON-allocatable price (3_000_000_000, which
  // leaves residual 6); the closest exactly-allocatable price for these
  // exact two lines is 2_999_999_994, one fil below it, confirmed
  // independently (task-2-report.md) to produce a BYTE-IDENTICAL allocation
  // to the old per-unit algorithm at that price. Using the exactly
  // allocatable price lets this test assert both speed AND the sum
  // invariant, rather than only speed.
  it('stays fast for a huge-vs-tiny quantity pairing (no per-unit stepping)', () => {
    const lines: BundleLine[] = [
      { key: 'big', unitPrice: 5, quantity: 1_000_000_000 },
      { key: 'small', unitPrice: 3, quantity: 7 },
    ];
    const price = 2_999_999_994;
    const t0 = Date.now();
    const out = allocateBundlePrice(lines, price);
    expect(Date.now() - t0).toBeLessThan(50);
    expect(out.reduce((s, l) => s + l.totalAllocated, 0)).toBe(price);
  });

  it('handles a zero-priced component without dividing by zero', () => {
    const withFree: BundleLine[] = [
      { key: 'main', unitPrice: 5000, quantity: 1 },
      { key: 'gift', unitPrice: 0, quantity: 1 },
    ];
    const out = allocateBundlePrice(withFree, 4000);
    expect(out.reduce((s, l) => s + l.totalAllocated, 0)).toBe(4000);
  });

  // A negative quantity made the residual-distribution loop increase
  // `residual` unconditionally instead of shrinking it, hanging the process
  // forever (verified with a hard OS timeout during development).
  //
  // RULING T2-d: the 2000ms timeout below is NOT a safety net against that
  // hang reopening. A synchronous infinite loop cannot be preempted by a JS
  // test timeout — verified directly (task-2-report.md): a real
  // `while(true){}` under this repo's exact vitest config (`pool: 'forks'`)
  // ran past its timeout and had to be killed externally. What actually
  // prevents the hang is assertValidLines() in bundle-pricing.ts; these
  // tests only assert that guard throws. If assertValidLines() is ever
  // weakened or removed, the guard is what's gone, and these tests would
  // HANG the whole suite (and CI) rather than fail fast — which is
  // precisely why that guard must never be removed. The timeout is left in
  // place only so a passing run doesn't cost extra wall-clock time; it is
  // not what makes a regression safe to ship.
  it('throws on a negative quantity instead of looping forever', () => {
    expect(() => allocateBundlePrice([{ key: 'bad', unitPrice: 1000, quantity: -1 }], 500)).toThrow(
      /quantity/i
    );
  }, 2000);

  it('throws on a zero quantity', () => {
    expect(() => allocateBundlePrice([{ key: 'bad', unitPrice: 1000, quantity: 0 }], 500)).toThrow(
      /quantity/i
    );
  }, 2000);

  it('throws on a non-integer quantity', () => {
    expect(() =>
      allocateBundlePrice([{ key: 'bad', unitPrice: 1000, quantity: 1.5 }], 500)
    ).toThrow(/quantity/i);
  }, 2000);

  it('throws on a negative unitPrice', () => {
    expect(() => allocateBundlePrice([{ key: 'bad', unitPrice: -1, quantity: 1 }], 500)).toThrow(
      /unitPrice/i
    );
  });

  it('throws on a non-integer unitPrice', () => {
    expect(() =>
      allocateBundlePrice([{ key: 'bad', unitPrice: 999.99, quantity: 1 }], 500)
    ).toThrow(/unitPrice/i);
  });
});

describe('isAllocatable', () => {
  it('accepts a price that splits exactly', () => {
    expect(isAllocatable(BOX, 12000)).toBe(true);
  });

  it('rejects a price no split can represent', () => {
    // Every quantity is 2, so every line total is even; an odd price cannot
    // be represented without breaking unit x quantity == total.
    const allPairs: BundleLine[] = [
      { key: 'a', unitPrice: 1000, quantity: 2 },
      { key: 'b', unitPrice: 3000, quantity: 2 },
    ];
    expect(isAllocatable(allPairs, 4001)).toBe(false);
    expect(isAllocatable(allPairs, 4000)).toBe(true);
  });

  // isAllocatable is a predicate over untrusted/derived candidates, so an
  // invalid BundleLine contract is reported as `false`, not thrown — see the
  // module doc on isAllocatable for why this differs from allocateBundlePrice.
  //
  // The 2000ms timeout is not a hang safety net (RULING T2-d) — see the
  // longer comment above the equivalent allocateBundlePrice tests. What
  // actually prevents a hang here is assertValidLines() inside the
  // allocateBundlePrice call this wraps; these tests only assert the
  // resulting `false`.
  it('returns false (never throws) for a negative quantity', () => {
    expect(isAllocatable([{ key: 'bad', unitPrice: 1000, quantity: -1 }], 500)).toBe(false);
  }, 2000);

  it('returns false (never throws) for a zero quantity', () => {
    expect(isAllocatable([{ key: 'bad', unitPrice: 1000, quantity: 0 }], 500)).toBe(false);
  }, 2000);

  it('returns false (never throws) for a non-integer quantity', () => {
    expect(isAllocatable([{ key: 'bad', unitPrice: 1000, quantity: 1.5 }], 500)).toBe(false);
  }, 2000);
});

describe('nearestAllocatablePrice', () => {
  it('returns the price unchanged when it already splits', () => {
    expect(nearestAllocatablePrice(BOX, 12000, SUM)).toBe(12000);
  });

  it('walks to the nearest representable price, preferring lower on a tie', () => {
    const allPairs: BundleLine[] = [
      { key: 'a', unitPrice: 1000, quantity: 2 },
      { key: 'b', unitPrice: 3000, quantity: 2 },
    ];
    // 4001 is not allocatable (odd); 4000 and 4002 are equidistant (both even,
    // both allocatable) -> prefer the lower value, 4000.
    expect(nearestAllocatablePrice(allPairs, 4001, 8000)).toBe(4000);
  });

  it('never returns a value outside [0, componentSum]', () => {
    const allPairs: BundleLine[] = [
      { key: 'a', unitPrice: 1000, quantity: 2 },
      { key: 'b', unitPrice: 3000, quantity: 2 },
    ];
    for (const desired of [-500, 0, 1, 4001, 7999, 8000, 9000]) {
      const result = nearestAllocatablePrice(allPairs, desired, 8000);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(8000);
      expect(isAllocatable(allPairs, result)).toBe(true);
    }
  });

  // nearestAllocatablePrice throws on an invalid contract rather than
  // silently sweeping [0, componentSum] via a never-true isAllocatable and
  // returning 0 without explanation — see the module doc for the reasoning.
  //
  // The 2000ms timeout is not a hang safety net (RULING T2-d) — see the
  // longer comment above the equivalent allocateBundlePrice tests. What
  // actually prevents a hang here is assertValidLines() called eagerly at
  // the top of nearestAllocatablePrice; these tests only assert it throws.
  it('throws on a negative quantity instead of degrading into a silent sweep', () => {
    expect(() =>
      nearestAllocatablePrice([{ key: 'bad', unitPrice: 1000, quantity: -1 }], 500, 5000)
    ).toThrow(/quantity/i);
  }, 2000);

  it('throws on a zero quantity', () => {
    expect(() =>
      nearestAllocatablePrice([{ key: 'bad', unitPrice: 1000, quantity: 0 }], 500, 5000)
    ).toThrow(/quantity/i);
  }, 2000);

  it('throws on a non-integer quantity', () => {
    expect(() =>
      nearestAllocatablePrice([{ key: 'bad', unitPrice: 1000, quantity: 1.5 }], 500, 5000)
    ).toThrow(/quantity/i);
  }, 2000);
});
