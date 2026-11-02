/**
 * Ruling WAREHOUSE-NEG-1: spread a reconcile deficit over the SKU's warehouse rows so NO row goes negative.
 * `rows` arrive in the shared order (default warehouse first, then priority desc, created_at asc); each gives what it
 * can (never more than its positive quantity, a row that is already negative gives nothing) until the deficit is
 * covered. `shortfall` > 0 means the rows cannot cover it: the caller leaves them floored at 0 and ALERTS.
 * The same file lives in apps/api/src/lib/warehouse-deficit.ts (the API must not import packages/repo statically);
 * tests/unit/warehouse-deficit.test.ts keeps the two byte-equal.
 */
export function planDeficit(
  rows: ReadonlyArray<{ id: string; quantity: number }>,
  deficit: number
): { takes: Array<{ id: string; amount: number }>; shortfall: number } {
  let left = deficit;
  const takes: Array<{ id: string; amount: number }> = [];
  for (const r of rows) {
    if (left <= 0) break;
    const amount = Math.min(Math.max(r.quantity, 0), left);
    if (amount > 0) {
      takes.push({ id: r.id, amount });
      left -= amount;
    }
  }
  return { takes, shortfall: left };
}
