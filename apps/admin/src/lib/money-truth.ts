/**
 * Unknown is not zero (QA 2026-11-17 N1/N2). A derived money figure whose input is missing must render as UNKNOWN
 * (or as an explicit partial), never as the arithmetic of "missing = 0": revenue with no cost of goods booked is not
 * a profit, and stock with no cost price is not worth 0.
 */

export type LedgerCostsStatus = 'known' | 'partial' | 'unknown';

interface LedgerCostsInput {
  revenue: number;
  cogs: number;
  /** From the API: known = every sold line has a cost, partial = some do not, unknown = none does. */
  costsStatus?: LedgerCostsStatus;
  /** Sold lines without a cost / all sold lines in the window (for the partial note). */
  costsMissing?: number;
  costsTotal?: number;
}

/**
 * Ledger window figures (ruling AN-7 + money review M1): unknown when revenue has no cost of goods at all, partial
 * when only some sold lines have a cost (the profit is then overstated). Trusts the API status; an older API without
 * it falls back to revenue>0 && cogs==0.
 */
export function ledgerCostsStatus(gl: LedgerCostsInput): LedgerCostsStatus {
  if (gl.costsStatus) return gl.costsStatus;
  return gl.revenue > 0 && gl.cogs === 0 ? 'unknown' : 'known';
}

type StockValueState =
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
