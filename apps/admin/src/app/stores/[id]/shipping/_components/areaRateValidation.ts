// Pure helpers shared by AreaRateEditor. Kept in a plain .ts module (no JSX)
// so they can be unit tested directly, without pulling in the client
// component's React/next-intl/@force/ui dependency graph.

export function kwdToFils(kwd: string): number {
  const n = parseFloat(kwd);
  if (isNaN(n) || n < 0) return 0;
  return Math.round(n * 1000);
}

export interface IncompleteRowCheckInput {
  /** DB id — present if the row was fetched from the server; absent if unsaved */
  id?: string;
  area: string;
  isActive: boolean;
  feeKwd: string;
}

/**
 * Brand-new custom zones/areas (never persisted — no `id`) that are still
 * inactive with no fee. `AreaRateEditor`'s `submitAddArea`/`submitAddLoc`
 * default `isActive` to `feeKwd !== ''`, so adding a zone without a fee
 * creates exactly this row. `handleSave`'s bulk-payload builder silently
 * filters rows matching `!isActive && fee === 0` — for these unsaved rows
 * that means the merchant's new zone never reaches the server, even though
 * the save reports success. Use this to block that save and tell the
 * merchant which zones need attention.
 */
export function getIncompleteNewRows<T extends IncompleteRowCheckInput>(customRows: T[]): T[] {
  return customRows.filter(row => !row.id && !row.isActive && kwdToFils(row.feeKwd) === 0);
}
