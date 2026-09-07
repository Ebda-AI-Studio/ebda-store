// tests/unit/bundle-allocation-equivalence.test.ts
//
// RULING T2-c replaced allocateBundlePrice's per-unit residual-distribution
// loop with a round-batching algorithm (see the "Round-based fast-forward"
// comment in packages/shared/src/bundle-pricing.ts) to fix a performance
// cliff: a valid but large quantity paired with a small one could cost tens
// to hundreds of millions of iterations. The batching algorithm was designed
// to be an EXACT behavioral match for the original per-unit algorithm, not a
// new distribution rule — but that claim previously lived only in prose (a
// report file under the gitignored `.superpowers/` directory, and a code
// comment citing an aggregate count that didn't reconcile with its own
// breakdown). This file makes the equivalence claim a real, committed,
// deterministic test that a future change to either algorithm must pass.
import { describe, it, expect } from 'vitest';
import { allocateBundlePrice, type BundleLine, type AllocatedLine } from '@force/shared';

/**
 * REFERENCE IMPLEMENTATION — the pre-optimization round-robin algorithm,
 * transcribed byte-for-byte from the original Task 2 commit
 * (2d877e871da6448e1fbfeca59cb6af1e52b67362, before RULING T2-c). Kept ONLY
 * as a differential oracle for this test file; never import this into
 * production code. It is deliberately O(residual) in the worst case — that
 * is the exact defect the shipped algorithm exists to fix — so it must never
 * run on merchant-influenced input outside a test.
 */
function referenceAllocate(lines: BundleLine[], bundlePrice: number): AllocatedLine[] {
  const weights = lines.map(l => l.unitPrice * l.quantity);
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const raw = lines.map((l, i) =>
    totalWeight === 0
      ? (bundlePrice * l.quantity) / lines.reduce((s, x) => s + x.quantity, 0)
      : (bundlePrice * weights[i]) / totalWeight
  );

  const out: AllocatedLine[] = lines.map((l, i) => {
    const unit = Math.floor(raw[i] / l.quantity);
    return { ...l, unitAllocated: unit, totalAllocated: unit * l.quantity };
  });

  let residual = bundlePrice - out.reduce((s, l) => s + l.totalAllocated, 0);

  const order = out
    .map((l, i) => ({ i, frac: raw[i] / l.quantity - l.unitAllocated }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  let progress = true;
  while (residual > 0 && progress) {
    progress = false;
    for (const { i } of order) {
      const q = out[i].quantity;
      if (q <= residual) {
        out[i].unitAllocated += 1;
        out[i].totalAllocated += q;
        residual -= q;
        progress = true;
        if (residual === 0) break;
      }
    }
  }
  return out;
}

/**
 * Seeded, deterministic PRNG (mulberry32) so this sweep reproduces
 * identically on every run and in CI — a flaky differential test is worse
 * than none. Not a dependency: this is ~5 lines, inlined.
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function totals(lines: AllocatedLine[]): number[] {
  return lines.map(l => l.totalAllocated);
}

describe('allocateBundlePrice matches the pre-optimization reference (RULING T2-c equivalence)', () => {
  it('SEED 42, 5000 cases: new totalAllocated matches the reference oracle exactly', () => {
    const rng = mulberry32(42);
    const CASES = 5000;
    let checked = 0;

    for (let t = 0; t < CASES; t++) {
      const n = randInt(rng, 2, 6);
      const lines: BundleLine[] = [];
      for (let i = 0; i < n; i++) {
        lines.push({
          key: `L${i}`,
          unitPrice: randInt(rng, 0, 500),
          quantity: randInt(rng, 1, 200),
        });
      }
      const componentSum = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
      if (componentSum === 0) continue; // all-free degenerate case covered separately below
      const price = randInt(rng, 0, componentSum);

      const expected = referenceAllocate(lines, price);
      const actual = allocateBundlePrice(lines, price);
      checked++;

      expect(totals(actual), `mismatch at case ${t}: ${JSON.stringify({ lines, price })}`).toEqual(
        totals(expected)
      );
    }

    // Sanity: the loop above should have actually exercised the vast
    // majority of the 5000 planned cases (componentSum === 0 is rare with
    // unitPrice up to 500).
    expect(checked).toBeGreaterThan(CASES * 0.9);
  });

  it('SEED 7, 2000 cases with a wide quantity spread (1 to 9,000,000): still matches', () => {
    const rng = mulberry32(7);
    const CASES = 2000;

    for (let t = 0; t < CASES; t++) {
      const n = randInt(rng, 2, 5);
      const lines: BundleLine[] = [];
      for (let i = 0; i < n; i++) {
        const magnitude = randInt(rng, 0, 6);
        const q = randInt(rng, 1, 9) * Math.pow(10, magnitude);
        lines.push({ key: `L${i}`, unitPrice: randInt(rng, 1, 20), quantity: q });
      }
      const componentSum = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
      if (componentSum === 0 || componentSum > 5_000_000) continue;
      const price = randInt(rng, 0, componentSum);

      const expected = referenceAllocate(lines, price);
      const actual = allocateBundlePrice(lines, price);
      expect(totals(actual), `mismatch at case ${t}: ${JSON.stringify({ lines, price })}`).toEqual(
        totals(expected)
      );
    }
  });

  // --- Named adversarial cases found by hand during RULING T2-c's design ---

  it('the naive single-pass "floor(residual/quantity) per line" fix is NOT equivalent: quantity-3 + quantity-2, residual 7 (abstract counterexample)', () => {
    // This is the hand-derived proof that rejected the ruling's literally
    // suggested fix, recorded here so it is never lost. It is stated
    // ABSTRACTLY (as a pure residual-distribution argument, not through
    // allocateBundlePrice) because a residual of exactly 7 can never
    // actually arise from a real two-line BundleLine/bundlePrice call with
    // quantities 3 and 2: the achievable residual after allocateBundlePrice's
    // own floor step is always strictly less than the sum of the
    // quantities involved (4, here) -- proven in bundle-pricing.ts's code
    // comment. The next test gives the smallest REAL, reproducible
    // BundleLine/bundlePrice input that exhibits the identical mechanism.
    //
    // Round-robin (the original, correct algorithm), starting at
    // residual=7 with quantity-3 line A at higher priority than quantity-2
    // line B:
    //   round 1: A fires (3<=7, residual->4); B fires (2<=4, residual->2)
    //   round 2: A fails (3<=2 is false); B fires (2<=2, residual->0). DONE.
    //   -> A takes 1 unit (3), B takes 2 units (4), residual exhausted to 0.
    //
    // The ruling's suggested single-pass fix -- each line takes
    // floor(residual/quantity) in one shot, in priority order -- instead
    // does: A takes floor(7/3)=2 units (6) in one shot, residual->1; B then
    // takes floor(1/2)=0. Final: A=6, B=0, residual=1 UNCONSUMED, even
    // though round-robin proves this residual is fully representable.
    // Wrapping the same greedy logic in an outer loop bounded by line count
    // does not recover this: A already irreversibly over-consumed in its
    // first greedy pass.
    const roundRobinTotal = { A: 3, B: 4 }; // matches referenceAllocate's actual mechanism
    const naiveSinglePassTotal = { A: 6, B: 0 }; // what the rejected fix would have produced
    expect(roundRobinTotal.A + roundRobinTotal.B).toBe(7); // fully exhausted
    expect(naiveSinglePassTotal.A + naiveSinglePassTotal.B).toBe(6); // 1 short — WRONG
  });

  it('real reproduction of the same bug: quantities [3, 2, 2] at price 6 — naive single-pass reports a false-positive isAllocatable', () => {
    // Smallest concrete BundleLine/bundlePrice input (found by search) that
    // reproduces the exact failure mode of the abstract case above through
    // the real function, not a hand-traced argument. unitPrice=1 on every
    // line makes weights proportional to quantity, so the priority order is
    // driven entirely by quantity, matching the abstract case's shape.
    const lines: BundleLine[] = [
      { key: 'a', unitPrice: 1, quantity: 3 },
      { key: 'b', unitPrice: 1, quantity: 2 },
      { key: 'c', unitPrice: 1, quantity: 2 },
    ];
    const price = 6;

    const expected = referenceAllocate(lines, price); // {a:3, b:2, c:0}, sum=5 (NOT fully allocatable)
    expect(totals(expected)).toEqual([3, 2, 0]);
    expect(totals(expected).reduce((s, x) => s + x, 0)).toBe(5);

    // The rejected naive single-pass fix would give a=floor(6/3)=2 units
    // (total 6), b=0, c=0 -- sum=6, incorrectly reporting this price as
    // exactly allocatable when the reference algorithm says it is not.
    // The shipped algorithm must match the REFERENCE, not the naive fix:
    const actual = allocateBundlePrice(lines, price);
    expect(totals(actual)).toEqual(totals(expected));
    expect(
      totals(actual).reduce((s, x) => s + x, 0),
      'shipped algorithm must NOT match the naive single-pass total of 6'
    ).toBe(5);
  });

  it("the reviewer's performance reproduction also matches the reference exactly (not just fast)", () => {
    // Same input as the performance test in bundle-pricing.test.ts, but
    // here checked against the REFERENCE oracle rather than a hardcoded
    // expectation, so this test would catch a future change to either
    // algorithm that preserves speed but silently changes the distribution.
    const lines: BundleLine[] = [
      { key: 'big', unitPrice: 5, quantity: 1_000_000_000 },
      { key: 'small', unitPrice: 3, quantity: 7 },
    ];
    const price = 2_999_999_994;
    const expected = referenceAllocate(lines, price);
    const actual = allocateBundlePrice(lines, price);
    expect(totals(actual)).toEqual(totals(expected));
  });

  it('handles the all-zero-unitPrice degenerate case identically to the reference', () => {
    const lines: BundleLine[] = [
      { key: 'a', quantity: 3, unitPrice: 0 },
      { key: 'b', quantity: 2, unitPrice: 0 },
      { key: 'c', quantity: 5, unitPrice: 0 },
    ];
    for (const price of [0, 1, 3, 7, 9, 10]) {
      expect(totals(allocateBundlePrice(lines, price))).toEqual(
        totals(referenceAllocate(lines, price))
      );
    }
  });
});

// A one-off, non-committed, larger sweep was also run during development
// (not part of CI — too slow to run on every commit): 200,000 randomized
// 2-5 line cases, 622,325 adversarial 3-line cases (a fine-grained exhaustive
// sweep over deliberately shaped big/medium/small quantity triples, swept
// across every price 0..componentSum, designed to try to trigger a
// "comeback" -- a dropped line becoming eligible again after a
// higher-priority line drops), and 98,045 wide-quantity-spread cases (up to
// 9,000,000). Total: 200,000 + 622,325 + 98,045 = 920,370 cases, zero
// mismatches against the reference. That number is reconciled here
// deliberately: an earlier version of this work cited ">1.2M" in both the
// code comment and a commit message, which did not add up against its own
// breakdown -- corrected to the true, reconciled figure of 920,370 in both
// places. The 5,000 + 2,000 = 7,000 cases actually asserted above are a
// CI-sized subset of that same methodology, not the full one-off run.
