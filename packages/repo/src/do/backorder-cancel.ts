import { MoneyError, type SyncSql } from './sync-sql';

/**
 * `cancelBackorder` on a StoreDO store (Ruling NZ-FEAT-1): the Postgres service's ONE transaction, as ONE `transactionSync`
 * section (the money op runner wraps it). Same four steps, same rows, same marker:
 *   1. CLAIM the line: only a still-open line (not cancelled, not fulfilled) is cancelled, exactly once; anything else is
 *      `{ found: false }` (the service answers 404 like the Postgres twin).
 *   2. Clear `order_items.cost_price_deferred` when no other open line remains on the item.
 *   3. Heal the stock debt a NON-variant backordered sale left: `min(units, -inventory)` back, never above 0, with its
 *      `return_stock` history row (ruling AP-5c; a variant line heals nothing, checkout floors variants at 0).
 *   4. The `backorder_line_cancelled` order event carrying `refundKey`, the items and `stockRestored`: the record every later
 *      allocation (GL `journalPartialReturn`, refunds, returns) counts as prior, and that a whole-order restore subtracts.
 * The item-level `order/refunded` event is sent by the service AFTER this section, keyed `backorder:<lineId>`, exactly as on
 * Postgres. Run it with the idempotency key `backorder-cancel:<lineId>` so a retried request replays this answer and re-sends
 * that (idempotent) event instead of a 404.
 */
export const BACKORDER_CANCEL_MARKER = 'backorder_line_cancelled';

const fail = (code: string, message: string): never => {
  throw new MoneyError(code, message, 400);
};

export function backorderCancelOp(db: SyncSql, storeId: string, a: Record<string, unknown>) {
  const lineId =
    typeof a.backorderLineId === 'string' &&
    a.backorderLineId.length > 0 &&
    a.backorderLineId.length <= 128
      ? a.backorderLineId
      : fail('BAD_ARGS', 'backorderLineId');
  const reason =
    typeof a.reason === 'string' && a.reason.length > 0 && a.reason.length <= 500
      ? a.reason
      : fail('BAD_ARGS', 'reason');
  const userId =
    a.userId === undefined || a.userId === null
      ? null
      : typeof a.userId === 'string' && a.userId.length <= 128
        ? a.userId
        : fail('BAD_ARGS', 'userId');

  const line = db.all(
    `SELECT bl.order_item_id, bl.product_id, bl.variant_id, bl.qty, bl.qty_fulfilled, oi.order_id
       FROM backorder_lines bl JOIN order_items oi ON oi.id = bl.order_item_id
      WHERE bl.id = ? AND bl.store_id = ? AND bl.cancelled_at IS NULL AND bl.fulfilled_at IS NULL`,
    [lineId, storeId]
  )[0];
  if (!line) return { found: false as const };
  const now = Date.now();
  const orderItemId = line.order_item_id as string;
  const orderId = line.order_id as string;
  const productId = line.product_id as string;
  const variantId = (line.variant_id as string | null) ?? null;

  // 1. claim
  db.run(
    'UPDATE backorder_lines SET cancelled_at = ?, cancelled_reason = ? WHERE id = ? AND store_id = ?',
    [now, reason, lineId, storeId]
  );
  const quantity = Math.max(0, (line.qty as number) - (line.qty_fulfilled as number));

  // 2. the deferred-cost flag, when this was the item's last open line
  const remainingOpen = Number(
    db.all(
      `SELECT COUNT(*) AS n FROM backorder_lines
        WHERE order_item_id = ? AND store_id = ? AND id <> ? AND fulfilled_at IS NULL AND cancelled_at IS NULL`,
      [orderItemId, storeId, lineId]
    )[0]?.n ?? 0
  );
  if (remainingOpen === 0)
    db.run('UPDATE order_items SET cost_price_deferred = 0 WHERE id = ?', [orderItemId]);

  if (quantity === 0)
    return { found: true as const, orderId, orderItemId, quantity, stockRestored: 0 };

  const refundKey = `backorder:${lineId}`;
  // 3. heal the stock debt (non-variant, tracked, negative only)
  let stockRestored = 0;
  if (!variantId) {
    const p = db.all(
      'SELECT inventory, track_inventory FROM products WHERE id = ? AND store_id = ?',
      [productId, storeId]
    )[0];
    const inv = p ? (p.inventory as number) : 0;
    if (p && Number(p.track_inventory) === 1 && inv < 0) {
      stockRestored = Math.min(quantity, -inv);
      db.run(
        'UPDATE products SET inventory = inventory + ?, updated_at = ? WHERE id = ? AND store_id = ?',
        [stockRestored, now, productId, storeId]
      );
      db.run(
        'INSERT INTO inventory_history (id, product_id, store_id, type, quantity, previous_stock, new_stock, reason, reference, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          crypto.randomUUID(),
          productId,
          storeId,
          'return_stock',
          stockRestored,
          inv,
          inv + stockRestored,
          'Backorder line cancelled — stock debt healed to 0',
          refundKey,
          userId,
        ]
      );
    }
  }

  // 4. the durable marker
  db.run(
    'INSERT INTO order_events (id, store_id, order_id, from_status, to_status, actor_id, metadata, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)',
    [
      crypto.randomUUID(),
      storeId,
      orderId,
      BACKORDER_CANCEL_MARKER,
      userId,
      JSON.stringify({
        refundKey,
        backorderLineId: lineId,
        reason,
        items: [{ orderItemId, quantity }],
        stockRestored,
      }),
      now,
    ]
  );
  return { found: true as const, orderId, orderItemId, quantity, stockRestored };
}
