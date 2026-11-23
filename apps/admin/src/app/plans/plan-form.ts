/**
 * Pure helpers for the super-admin plan editor. The API contract stores fees
 * in basis points (bps, 100 = 1%); the editor shows and edits percentages.
 */

/** bps -> the percentage string shown in an input (150 -> "1.5", 0 -> "0"). */
export function bpsToPercentInput(bps: number): string {
  return String(Number((bps / 100).toFixed(2)));
}

/**
 * Percentage string -> bps. Returns NaN when blank, not a plain decimal,
 * outside 0-100, or with more than 2 decimals.
 */
export function percentInputToBps(value: string): number {
  const v = value.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return Number.NaN;
  const pct = Number(v);
  if (pct > 100) return Number.NaN;
  return Math.round(pct * 100);
}
