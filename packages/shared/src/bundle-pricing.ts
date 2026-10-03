/**
 * Bundle price + allocation. Integer piastres throughout — no floats, ever.
 *
 * Allocation runs on UNIT shares, not line totals, because OrderItem stores
 * both a unit `price` and a `total`. A line total that is not divisible by its
 * quantity cannot be stored without one of those two lying.
 *
 * `BundlePricingType` is declared locally (not imported from `@force/database`)
 * so this package stays DB-free (RULING C1). It is structurally identical to
 * the Prisma enum of the same name.
 */

export type BundlePricingType = 'fixed_price' | 'percentage' | 'fixed';

export interface BundleLine {
  key: string;
  unitPrice: number; // piastres, the component's effective unit price
  quantity: number; // >= 1
}

export interface AllocatedLine extends BundleLine {
  unitAllocated: number;
  totalAllocated: number;
}

/**
 * Enforces the `BundleLine` contract documented above: `quantity` is an
 * integer >= 1, `unitPrice` is an integer >= 0. A `quantity <= 0` (or
 * fractional) line was found to make `allocateBundlePrice`'s residual
 * distribution loop non-terminating — a hang, not a wrong answer — so this
 * is validated eagerly rather than left to the loop to discover.
 *
 * Throws rather than returning a sentinel: `allocateBundlePrice` is the
 * function that would otherwise hang, so it must fail loudly and immediately
 * on the input that would have caused that. `isAllocatable` (a predicate
 * callers use to ask questions about untrusted/derived price candidates)
 * catches this and returns `false` instead of throwing — see its
 * implementation below.
 */
function assertValidLines(lines: BundleLine[]): void {
  for (const l of lines) {
    if (!Number.isInteger(l.quantity) || l.quantity < 1) {
      throw new Error(
        `bundle line "${l.key}" has quantity ${l.quantity}; quantity must be an integer >= 1`
      );
    }
    if (!Number.isInteger(l.unitPrice) || l.unitPrice < 0) {
      throw new Error(
        `bundle line "${l.key}" has unitPrice ${l.unitPrice}; unitPrice must be an integer >= 0`
      );
    }
  }
}

/** Price of the bundle in piastres, given the sum of its components. */
export function computeBundlePrice(
  componentSum: number,
  pricingType: BundlePricingType,
  pricingValue: number
): number {
  let price: number;
  switch (pricingType) {
    case 'fixed_price':
      price = pricingValue;
      break;
    case 'percentage':
      // basis points: 12.5% -> 1250. Floor the discount so rounding favours
      // the merchant rather than silently discounting an extra piastre.
      price = componentSum - Math.floor((componentSum * pricingValue) / 10000);
      break;
    case 'fixed':
      price = componentSum - pricingValue;
      break;
  }
  return Math.max(0, Math.min(price, componentSum));
}

/**
 * Split `bundlePrice` across `lines` by value weight.
 *
 * Guarantees, when `isAllocatable(lines, bundlePrice)`:
 *   1. sum(totalAllocated) === bundlePrice
 *   2. unitAllocated * quantity === totalAllocated for every line
 */
export function allocateBundlePrice(lines: BundleLine[], bundlePrice: number): AllocatedLine[] {
  assertValidLines(lines);

  const weights = lines.map(l => l.unitPrice * l.quantity);
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  // Degenerate: every component is free. Spread evenly by quantity instead of
  // dividing by zero.
  const raw = lines.map((l, i) =>
    totalWeight === 0
      ? (bundlePrice * l.quantity) / lines.reduce((s, x) => s + x.quantity, 0)
      : (bundlePrice * weights[i]) / totalWeight
  );

  const out: AllocatedLine[] = lines.map((l, i) => {
    const unit = Math.floor(raw[i] / l.quantity);
    return { ...l, unitAllocated: unit, totalAllocated: unit * l.quantity };
  });

  distributeResidual(out, raw, bundlePrice - out.reduce((s, l) => s + l.totalAllocated, 0));
  return out;
}

/**
 * Hand the integer residual left by the floor pass back out, largest
 * fractional remainder first, in closed-form ROUNDS (see the comment in the
 * body). Mutates `out` in place. Extracted from `allocateBundlePrice`
 * unchanged (issue 1809) — the equivalence suite
 * (tests/unit/bundle-allocation-equivalence.test.ts) pins it.
 */
function distributeResidual(out: AllocatedLine[], raw: number[], initialResidual: number): void {
  let residual = initialResidual;

  // Largest fractional remainder first. Adding 1 to a unit adds `quantity` to
  // that line, so only lines that fit inside the residual are eligible.
  const order = out
    .map((l, i) => ({ i, frac: raw[i] / l.quantity - l.unitAllocated }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  // Distribute the residual in ROUNDS: a round walks `active` once, in
  // priority order, giving each line that still fits (its quantity <= the
  // residual remaining AT ITS OWN turn in this round) exactly +1 unit, same
  // as the original per-unit algorithm's inner pass. The original bug was
  // stepping this one round at a time even when the SAME set of lines would
  // keep firing for millions of consecutive rounds (e.g. one huge-quantity
  // line paired with one tiny-quantity line: the tiny line alone can fire
  // ~residual/quantity times before the loop resolves or gives up).
  //
  // Instead of repeating identical rounds one at a time, compute in closed
  // form how many CONSECUTIVE rounds the CURRENT firing set can repeat
  // identically — bounded by (a) how many full rounds the remaining residual
  // can even sustain, and (b) the first line in that set whose own
  // within-round checkpoint would drop below its quantity — and apply all of
  // them in one arithmetic step. A line that fails to fire in a round never
  // fires again in any LATER round with the SAME (unchanged) firing set,
  // because every line's checkpoint only decreases as the set repeats
  // (proved in task-2-report.md); once a round produces a SMALLER firing set
  // than the previous one, `active` is narrowed to just the survivors, since
  // a fresh full re-simulation of any dropped line would still exclude it
  // (its checkpoint is only ever lower from here on). This was verified
  // against the original per-unit algorithm across 920,370 randomized and
  // adversarial cases during development (200,000 randomized + 622,325
  // adversarial + 98,045 wide-quantity-spread; task-2-report.md) with zero
  // divergence, plus a smaller seeded/deterministic subset of the same
  // methodology committed as tests/unit/bundle-allocation-equivalence.test.ts
  // so the equivalence claim is re-checked on every run, not just asserted
  // in prose. Gives an exactly-bounded number of outer iterations (at most
  // ~2x the number of lines), never the residual's magnitude.
  let active = order.map(o => o.i);
  while (residual > 0 && active.length > 0) {
    let running = residual;
    const firing: number[] = [];
    for (const i of active) {
      const q = out[i].quantity;
      if (q <= running) {
        firing.push(i);
        running -= q;
      }
    }
    if (firing.length === 0) break; // nobody fits any more -> done

    const consumedPerRound = residual - running;

    if (firing.length < active.length) {
      // Not everyone in `active` fired: at least one line just dropped out
      // permanently. Apply this ONE round for real and narrow `active` to
      // the survivors — they're the only ones that can ever fire again.
      for (const i of firing) {
        out[i].unitAllocated += 1;
        out[i].totalAllocated += out[i].quantity;
      }
      residual -= consumedPerRound;
      active = firing;
      continue;
    }

    // Everyone currently in `active` fired this round. Find how many more
    // consecutive identical rounds are safe: the residual-imposed cap, and
    // the first line whose own checkpoint would fail next.
    let checkpoint = residual;
    let boundedByLine = Infinity;
    for (const i of active) {
      const q = out[i].quantity;
      const roundsThisLineCanSustain = Math.floor((checkpoint - q) / consumedPerRound) + 1;
      if (roundsThisLineCanSustain < boundedByLine) boundedByLine = roundsThisLineCanSustain;
      checkpoint -= q;
    }
    const boundedByResidual = Math.floor(residual / consumedPerRound);
    const rounds = Math.min(boundedByLine, boundedByResidual);

    for (const i of active) {
      const q = out[i].quantity;
      out[i].unitAllocated += rounds;
      out[i].totalAllocated += rounds * q;
    }
    residual -= rounds * consumedPerRound;
  }
}

/**
 * True when `bundlePrice` can be split with both invariants intact.
 *
 * Unlike `allocateBundlePrice`, this never throws: it is a predicate callers
 * use to ask questions about untrusted or computed price candidates (e.g.
 * `nearestAllocatablePrice`'s search), so an invalid `lines` contract is
 * reported the same way an unrepresentable price is — as `false` — rather
 * than as an exception.
 */
export function isAllocatable(lines: BundleLine[], bundlePrice: number): boolean {
  if (bundlePrice < 0) return false;
  try {
    const out = allocateBundlePrice(lines, bundlePrice);
    return out.reduce((s, l) => s + l.totalAllocated, 0) === bundlePrice;
  } catch {
    return false;
  }
}

/**
 * The closest price to `desired` that `allocateBundlePrice` can represent
 * exactly. Walks outward from `desired`, preferring the lower value on a tie
 * so the merchant is never surprised by a higher price than they typed.
 * Returns `desired` when it is already allocatable, and clamps the search to
 * [0, componentSum].
 *
 * Like `allocateBundlePrice` (and unlike `isAllocatable`), this throws on an
 * invalid `lines` contract rather than swallowing it: `isAllocatable` would
 * just return `false` for every candidate in [0, componentSum], so an
 * invalid input would otherwise silently degrade into a full O(componentSum)
 * sweep that can never succeed, returning `0` without ever explaining why.
 */
export function nearestAllocatablePrice(
  lines: BundleLine[],
  desired: number,
  componentSum: number
): number {
  assertValidLines(lines);

  const lo = 0;
  const hi = componentSum;
  const clamped = Math.max(lo, Math.min(desired, hi));

  if (isAllocatable(lines, clamped)) return clamped;

  for (let delta = 1; delta <= hi - lo; delta++) {
    const down = clamped - delta;
    const up = clamped + delta;
    const downValid = down >= lo;
    const upValid = up <= hi;
    // Prefer the lower value on a tie (check down before up).
    if (downValid && isAllocatable(lines, down)) return down;
    if (upValid && isAllocatable(lines, up)) return up;
    if (!downValid && !upValid) break;
  }

  // Every price in [0, componentSum] failed — 0 is always allocatable
  // (every unitAllocated is 0), so this is unreachable in practice.
  return 0;
}
