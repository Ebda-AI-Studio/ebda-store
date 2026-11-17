/**
 * Unknown is not zero (QA 2026-11-17 N1/N2). A derived money figure whose input is missing must render as UNKNOWN
 * (or as an explicit partial), never as the arithmetic of "missing = 0": revenue with no cost of goods booked is not
 * a profit, and stock with no cost price is not worth 0.
 */

/** Ledger window figures: false when the period has revenue but no cost of goods was booked (ruling AN-7). */
export function ledgerCostsKnown(gl: {
  revenue: number;
  cogs: number;
  costsKnown?: boolean;
}): boolean {
  if (typeof gl.costsKnown === 'boolean') return gl.costsKnown;
  return !(gl.revenue > 0 && gl.cogs === 0);
}

export type StockValueState =
  | { kind: 'full'; value: number }
  /** Some stocked products have no cost: `value` covers only `costed` of `stocked`. */
  | { kind: 'partial'; value: number; costed: number; stocked: number }
  /** Every stocked product lacks a cost: the value is unknown, not 0. */
  | { kind: 'unknown' };

/**
 * `stockedProducts` / `uncostedProducts` come from the API; an older API omits them, which is treated as fully costed
 * (the previous behaviour) rather than guessed.
 */
export function stockValueState(s: {
  stockValue: number;
  stockedProducts?: number;
  uncostedProducts?: number;
}): StockValueState {
  const stocked = s.stockedProducts ?? 0;
  const uncosted = s.uncostedProducts ?? 0;
  if (stocked > 0 && uncosted >= stocked) return { kind: 'unknown' };
  if (uncosted > 0) {
    return { kind: 'partial', value: s.stockValue, costed: stocked - uncosted, stocked };
  }
  return { kind: 'full', value: s.stockValue };
}
