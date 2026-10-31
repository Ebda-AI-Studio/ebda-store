// VERBATIM COPY of packages/shared/src/pricing/return-adjustment.ts (the engine imports no workspace package, like pricing.ts/tax.ts).
// tests/unit/do-return-math-parity.test.ts keeps it equal to the original (fuzzed) so the copy cannot drift. Ruling CF-RETURNS-1.
/**
 * Partial-return repricing of tier-priced lines: the ONE pure place it is decided (Rulings B2B-13, B2B-14, B2B-17, B2B-18;
 * Task 8b). No imports, no Date, no randomness, integers only (same purity contract as resolve-unit-price.ts).
 *
 * SCOPE (Ruling B2B-17). A tier was awarded on the quantity of the whole PRODUCT across every loose line of the order
 * (variants and personalisation-split note-lines summed, Ruling B2B-4), and a variant-level tier on the quantity of that
 * VARIANT across its lines. A return is judged the same way: `productReturnAdjustment` takes EVERY loose line of one product
 * (those on this return and those not), re-runs the B2B-3b selection on the kept product / variant quantities, and reprices
 * the kept units of every line. Splitting one variant into lines, or a size run into variants, can not escape it.
 *
 * ENTITLEMENT (Ruling B2B-18, amends B2B-13). The kept units are repriced at what the buyer was entitled to at sale time
 * for the kept quantity: min(list, the group-percent price, the best public tier reached, the best group tier reached), as
 * the snapshot recorded them. Never bare list price when the buyer's group percent applies at every quantity.
 *
 *   keptUnit(line)  = max(b, min(L, gPct, pub(kept), gTier(kept)))   b = paid unit, L = list, from the line's snapshot
 *   clawback(state) = sum over tier lines of (keptUnit(line) - b) * keptOnLine
 *   adjustment      = clawback(after this return) - clawback(before it)          cumulative: never double-charges
 *
 * The product-level adjustment is then bounded and spread over THIS return's lines of the product:
 *   > 0  capped at their standard refund (the buyer is never charged; the excess is reported as `shortfall`)
 *   < 0  a release (the kept quantity went back over a threshold, or the last units came back), never more than the
 *        product's earlier returns actually retained (`retained`), so the sum of refunds can not exceed what was paid
 *   allocated by each item's standard refund (paid unit x units returned), largest remainder, so the integers sum exactly.
 *
 * CARRY (Ruling B2B-20). What the floor swallowed is not lost: it is carried forward (`shortfall`) and the product's next
 * return adds it to its raw adjustment BEFORE the floor and the release clamp (`carried`). So a release first cancels the
 * carry and only then hands back what was retained, and a charge collects the carry from that return's refund, never below
 * 0. Without overrides `retained + shortfall == clawback(kept now)` after every return: the carry is consumed exactly once.
 *
 * 'group', 'base', a missing snapshot and a missing ladder are never repriced (their kept units cost what they were paid).
 */

/** A type alias, not an interface, so it stays assignable to Prisma's Json input. */
export type SnapshotRung = {
  minQty: number;
  priceMinor: number;
  /** A variant-level tier: reached on the VARIANT's kept quantity. Else product-level: reached on the PRODUCT's. */
  variant: boolean;
  /** The buyer's group tier. Else a public tier. */
  group: boolean;
};

/** What `order_items.tier_ladder` holds (written by `priceSnapshot`). */
export type TierLadderSnapshot = {
  rungs: SnapshotRung[];
  /** The buyer's group-percent unit price at sale time; null when they had no active percent_off group. */
  groupPercentMinor: number | null;
};

export interface ReturnLineInput {
  /** The caller's key for this order line. Unique within one call. */
  key: string;
  variantId: string | null;
  /** Units on the order line. */
  quantity: number;
  /** Paid unit price (OrderItem.price). */
  paidUnitMinor: number;
  /** Retail unit price at sale time; null on a line sold before the snapshot existed. */
  listMinor: number | null;
  priceSource: 'base' | 'tier' | 'group' | null;
  /** The tier threshold the line reached; null unless priceSource is 'tier'. */
  tierMinQty: number | null;
  /** Snapshotted at sale time; null = none persisted (never guessed). */
  ladder: TierLadderSnapshot | null;
  /** Units of this line taken back before this return (earlier returns, backorder cancels). */
  returnedBefore: number;
  /** Units of this line on THIS return (0 for a line of the product that is not on it). */
  returning: number;
}

export interface ReturnItemShare {
  /** The caller's key for this RETURN item (several items may name one order line). */
  key: string;
  /** The order line's key (ReturnLineInput.key). */
  lineKey: string;
  /** Units this item returns, already clamped by the caller to what the line had left. */
  returning: number;
}

export interface ReturnItemAdjustment {
  key: string;
  /** Paid unit price x units returned. */
  standardRefund: number;
  /** Signed: positive reduces the refund. This item's share of the product's applied adjustment. */
  adjustment: number;
  adjustedRefund: number;
  /** The unit price this item's line keeps its units at after this return (the paid price when unchanged). */
  keptUnitMinor: number;
}

export interface ProductReturnAdjustment {
  /** Units of the product the buyer keeps after this return (the quantity the tier is judged on). */
  keptQty: number;
  /** clawback(after) - clawback(before), before the carry, the floor and the release clamp. */
  rawAdjustment: number;
  /** The shortfall earlier returns of this product carried forward, added to `rawAdjustment` here (Ruling B2B-20). */
  carriedIn: number;
  /** What is actually applied across this return's items (sum of their `adjustment`). */
  applied: number;
  /** What the floor at 0 swallowed (carry included); carried forward to the product's next return (Ruling B2B-20). */
  shortfall: number;
  reason: 'none' | 'kept_below_tier' | 'released';
  items: ReturnItemAdjustment[];
}

const INT4_MAX = 2_147_483_647;

function assertInt(name: string, v: unknown, min: number): asserts v is number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > INT4_MAX) {
    throw new RangeError(
      `productReturnAdjustment: ${name} must be an integer in [${min}, ${INT4_MAX}], got ${String(v)}`
    );
  }
}

/** Ruling B2B-3b on the snapshot: within one audience variant-level beats product-level, then the lowest price. */
function bestRung(
  rungs: readonly SnapshotRung[],
  group: boolean,
  productKept: number,
  variantKept: number
): number | null {
  let best: SnapshotRung | null = null;
  for (const r of rungs) {
    if (r.group !== group) continue;
    if (r.minQty > (r.variant ? variantKept : productKept)) continue;
    if (
      best === null ||
      (r.variant && !best.variant) ||
      (r.variant === best.variant && r.priceMinor < best.priceMinor)
    ) {
      best = r;
    }
  }
  return best === null ? null : best.priceMinor;
}

/** Spread `amount` (any sign) over `weights` pro-rata, largest remainder, ties to the earlier index; sums exactly. */
function allocate(amount: number, weights: readonly number[]): number[] {
  const out = weights.map(() => 0);
  if (amount === 0 || weights.length === 0) return out;
  const sign = amount < 0 ? -1 : 1;
  const abs = Math.abs(amount);
  const total = weights.reduce((s, w) => s + w, 0);
  const w = total > 0 ? weights : weights.map(() => 1);
  const t = total > 0 ? total : weights.length;
  let given = 0;
  const rem = w.map((wi, i) => {
    const exact = abs * wi; // <= 2^31 * 2^31 * k: kept exact below 2^53 for every real order (Int4 piastres x Int4 units)
    out[i] = Math.floor(exact / t);
    given += out[i]!;
    return { i, r: exact % t };
  });
  rem.sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; k < abs - given; k++) out[rem[k % rem.length]!.i]! += 1;
  return sign < 0 ? out.map(v => 0 - v) : out;
}

/**
 * @param lines   EVERY loose (non-bundle) line of ONE product on the order.
 * @param items   This return's items of that product (each names a line).
 * @param retained What this product's earlier completed returns retained in total (signed sum of their persisted
 *                 adjustments); bounds a release.
 * @param carried  The shortfall this product's earlier returns carried forward and nothing has consumed yet (Ruling B2B-20).
 */
export function productReturnAdjustment(
  lines: readonly ReturnLineInput[],
  items: readonly ReturnItemShare[],
  retained: number,
  carried = 0
): ProductReturnAdjustment {
  assertInt('carried', carried, 0);
  const byKey = new Map<string, ReturnLineInput>();
  for (const l of lines) {
    if (byKey.has(l.key)) throw new RangeError(`productReturnAdjustment: duplicate line ${l.key}`);
    assertInt('quantity', l.quantity, 1);
    assertInt('paidUnitMinor', l.paidUnitMinor, 0);
    assertInt('returnedBefore', l.returnedBefore, 0);
    assertInt('returning', l.returning, 0);
    if (l.returnedBefore + l.returning > l.quantity) {
      throw new RangeError('productReturnAdjustment: cannot return more units than are kept');
    }
    if (l.ladder !== null) {
      for (const r of l.ladder.rungs) {
        assertInt('rung.minQty', r.minQty, 1);
        assertInt('rung.priceMinor', r.priceMinor, 0);
      }
      if (l.ladder.groupPercentMinor !== null)
        assertInt('groupPercentMinor', l.ladder.groupPercentMinor, 0);
    }
    byKey.set(l.key, l);
  }
  for (const it of items) {
    if (!byKey.has(it.lineKey))
      throw new RangeError(`productReturnAdjustment: unknown line ${it.lineKey}`);
    assertInt('item.returning', it.returning, 0);
  }

  const keptOf = (l: ReturnLineInput, after: boolean) =>
    l.quantity - l.returnedBefore - (after ? l.returning : 0);
  const sums = (after: boolean) => {
    let product = 0;
    const variant = new Map<string | null, number>();
    for (const l of lines) {
      const k = keptOf(l, after);
      product += k;
      variant.set(l.variantId, (variant.get(l.variantId) ?? 0) + k);
    }
    return { product, variant };
  };
  const applicable = (l: ReturnLineInput) =>
    l.priceSource === 'tier' && l.tierMinQty !== null && l.listMinor !== null && l.ladder !== null;
  const keptUnit = (
    l: ReturnLineInput,
    s: { product: number; variant: Map<string | null, number> }
  ): number => {
    const b = l.paidUnitMinor;
    if (!applicable(l)) return b;
    const vKept = l.variantId === null ? s.product : (s.variant.get(l.variantId) ?? 0);
    let unit = l.listMinor!;
    for (const p of [
      l.ladder!.groupPercentMinor,
      bestRung(l.ladder!.rungs, false, s.product, vKept),
      bestRung(l.ladder!.rungs, true, s.product, vKept),
    ]) {
      if (p !== null && p < unit) unit = p;
    }
    return Math.max(b, unit);
  };
  const clawback = (after: boolean) => {
    const s = sums(after);
    let c = 0;
    for (const l of lines) c += (keptUnit(l, s) - l.paidUnitMinor) * keptOf(l, after);
    return c;
  };

  const before = clawback(false);
  const after = clawback(true);
  const rawAdjustment = after - before;
  const sAfter = sums(true);
  const standards = items.map(it => byKey.get(it.lineKey)!.paidUnitMinor * it.returning);
  const standardTotal = standards.reduce((a, b) => a + b, 0);
  // The carry is collected first (B2B-20): a release cancels it before handing anything back, a charge adds it.
  const effective = rawAdjustment + carried;
  const applied =
    effective >= 0
      ? Math.min(effective, standardTotal)
      : Math.max(effective, 0 - Math.max(0, retained)); // `0 -`, not unary minus: never -0
  const shares = allocate(applied, standards);
  return {
    keptQty: sAfter.product,
    rawAdjustment,
    carriedIn: carried,
    applied,
    shortfall: Math.max(0, effective - standardTotal),
    // From the APPLIED value: a release clamped to nothing is not a release (review minor 3).
    reason: applied > 0 ? 'kept_below_tier' : applied < 0 ? 'released' : 'none',
    items: items.map((it, i) => ({
      key: it.key,
      standardRefund: standards[i]!,
      adjustment: shares[i]!,
      adjustedRefund: standards[i]! - shares[i]!,
      keptUnitMinor: keptUnit(byKey.get(it.lineKey)!, sAfter),
    })),
  };
}
