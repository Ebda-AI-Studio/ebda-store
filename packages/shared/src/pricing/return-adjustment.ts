/**
 * returnAdjustment - the ONE pure place a partial return of a tier-priced line is repriced (Ruling B2B-10 / B2B-13, Task 8b).
 * No imports, no Date, no randomness, integers only (same purity contract as resolve-unit-price.ts).
 *
 * A buyer paid the tier price `b` for `N` units because the line reached the tier at `m` units. If a partial return drops the
 * units KEPT below `m`, the kept units no longer earned that price: they are repriced at the LOWEST price still on offer at
 * their quantity (the persisted ladder `T`, which is what the buyer could see at sale time; never a live table), else the list
 * price `L`, and the refund is reduced by the difference on the kept units.
 *
 *   keptUnit(kept) = b                                   when kept >= m (the tier is still reached)
 *                    lowest t.priceMinor in T            with t.minQty <= kept and t.priceMinor >= b
 *                    else L
 *   clawback(kept) = (keptUnit(kept) - b) * kept         when source is 'tier', m, L and T are known and kept > 0, else 0
 *   adjustment     = clawback(kept) - clawback(keptBefore)      (cumulative: partial returns never double-charge)
 *   standard       = b * k
 *   adjusted       = max(0, standard - adjustment)       the buyer is never charged; when the floor bites the difference is
 *                                                        reported as `shortfall` for the merchant
 *
 * `adjustment` is NEGATIVE when this return lifts the kept quantity back over a threshold or returns the last units (the
 * earlier clawback is released), so over any sequence of returns the adjustments telescope to clawback(finalKept).
 * 'group' (percent), 'base', a missing snapshot and a missing ladder never adjust.
 */

export interface LadderRung {
  minQty: number;
  priceMinor: number;
}

export interface ReturnAdjustmentInput {
  /** Units on the order line. */
  quantity: number;
  /** Paid unit price (OrderItem.price). */
  paidUnitMinor: number;
  /** Retail unit price at sale time; null on a line sold before the snapshot existed. */
  listMinor: number | null;
  priceSource: 'base' | 'tier' | 'group' | null;
  /** The tier threshold the line reached; null unless priceSource is 'tier'. */
  tierMinQty: number | null;
  /** The ladder snapshotted at sale time; null = none persisted (never guessed). */
  ladder: readonly LadderRung[] | null;
  /** Units of this line already taken back by earlier returns. */
  returnedBefore: number;
  /** Units being returned now. */
  returning: number;
}

export interface ReturnAdjustment {
  keptQty: number;
  standardRefund: number;
  /** Signed: positive reduces the refund. */
  adjustment: number;
  adjustedRefund: number;
  /** What the floor at 0 swallowed; > 0 only when adjustment exceeds the standard refund. */
  shortfall: number;
  /** The unit price the kept units are repriced to (the paid price when nothing changes). */
  keptUnitMinor: number;
  tierMinQty: number | null;
  reason: 'none' | 'kept_below_tier' | 'released';
}

const INT4_MAX = 2_147_483_647;

function assertInt(name: string, v: unknown, min: number): asserts v is number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > INT4_MAX) {
    throw new RangeError(
      `returnAdjustment: ${name} must be an integer in [${min}, ${INT4_MAX}], got ${String(v)}`
    );
  }
}

export function returnAdjustment(i: ReturnAdjustmentInput): ReturnAdjustment {
  assertInt('quantity', i.quantity, 1);
  assertInt('paidUnitMinor', i.paidUnitMinor, 0);
  assertInt('returnedBefore', i.returnedBefore, 0);
  assertInt('returning', i.returning, 0);
  const keptBefore = i.quantity - i.returnedBefore;
  if (keptBefore < 0 || i.returning > keptBefore) {
    throw new RangeError('returnAdjustment: cannot return more units than are kept');
  }
  const b = i.paidUnitMinor;
  const kept = keptBefore - i.returning;
  const standardRefund = b * i.returning;

  const applicable =
    i.priceSource === 'tier' && i.tierMinQty !== null && i.listMinor !== null && i.ladder !== null;
  const m = i.tierMinQty ?? 0;
  const L = i.listMinor ?? 0;

  const keptUnit = (n: number): number => {
    if (!applicable || n >= m) return b;
    let best: number | null = null;
    for (const t of i.ladder!) {
      if (t.minQty <= n && t.priceMinor >= b && (best === null || t.priceMinor < best))
        best = t.priceMinor;
    }
    return best ?? L;
  };
  const clawback = (n: number): number => (applicable && n > 0 ? (keptUnit(n) - b) * n : 0);

  const adjustment = clawback(kept) - clawback(keptBefore);
  const adjustedRefund = Math.max(0, standardRefund - adjustment);
  const shortfall = Math.max(0, adjustment - standardRefund);
  return {
    keptQty: kept,
    standardRefund,
    adjustment,
    adjustedRefund,
    shortfall,
    keptUnitMinor: keptUnit(kept),
    tierMinQty: applicable ? m : null,
    reason: adjustment > 0 ? 'kept_below_tier' : adjustment < 0 ? 'released' : 'none',
  };
}
