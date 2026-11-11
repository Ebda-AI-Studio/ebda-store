/**
 * #633 / Ruling STOCK-SYMMETRY-1, Postgres side (the DO side is `packages/repo/src/do/admin-order.ts` + `refund.ts`).
 * A manual (phone) order takes NO stock at placement, so it records this order event listing every line:
 * `{ items: [{ orderItemId, quantity }] }`. A cancel / refund / partial-return restock reads it and puts back none of
 * those units (it used to add the whole order back: phantom inventory, then an oversell).
 */
export const STOCK_NOT_TAKEN_EVENT = 'stock_not_taken';

/** Adds every `stock_not_taken` marker's units to `neverTaken` (orderItemId -> units never taken). */
export function addStockNotTaken(
  markers: Array<{ metadata: unknown }>,
  neverTaken: Map<string, number>
): void {
  for (const m of markers) {
    const items = (m.metadata as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) continue;
    for (const it of items as Array<{ orderItemId?: unknown; quantity?: unknown }>) {
      if (
        typeof it?.orderItemId !== 'string' ||
        !Number.isInteger(it.quantity) ||
        (it.quantity as number) <= 0
      )
        continue;
      neverTaken.set(
        it.orderItemId,
        (neverTaken.get(it.orderItemId) ?? 0) + (it.quantity as number)
      );
    }
  }
}
