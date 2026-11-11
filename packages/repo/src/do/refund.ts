import { settleFiscalOnReversal } from './fiscal';
import { postWalletMovementJournal } from './ledger';
import { reverseEarnedPointsFromOrder, reverseRedeemedPointsFromOrder } from './loyalty';
import { recordTrimmedCredit, refundableBalance } from './refundable';
import { recordMovement, restock } from './stock';
import { MoneyError, type SyncSql } from './sync-sql';

/**
 * Cancel / refund money effects on the StoreDO. Port of apps/api/src/lib/inngest/functions/order-refunded.ts (the
 * reversal fanout), OrderService.applyRefundEffects, wallet.service.ts (applyEntry / reverseOrderPayment /
 * creditForReturn) and the stock+coupon+wallet+loyalty half of return.service.ts. Pure synchronous functions over
 * `SyncSql`; ONE `transactionSync` per call (any throw rolls everything back); every query is scoped by `store_id`;
 * integers only.
 *
 * Idempotency (a second call never moves stock, a coupon use or wallet money again):
 *   whole order  inventory_history `return_stock` rows referenced by the order, order_events `coupon_reversed`,
 *                wallet ledger key `order-payment-reversal:<orderId>`, tagged loyalty `adjust` rows, backorder lines'
 *                cancelled_at; completion claim = orders.refund_reversed_at (armed by refund_reversal_requested_at)
 *   partial      order_events `partial_return_restored` / `partial_refund_recorded` keyed by the caller's refundKey,
 *                wallet key `return-credit:<refundKey>`
 *
 * Semantics copied from the original:
 *   - cancel/full refund restore EVERY line minus what completed partial returns and backorder heals already put back,
 *     minus units a backordered variant line never took (`stock_taken`), plus units a PO receipt supplied;
 *   - a partial event restocks only the listed lines and runs NO whole-order reversal (coupon, loyalty, wallet stay);
 *   - the coupon use is released once, floored at 0; the wallet spend comes back minus pro-rata shares already
 *     returned through `return-wallet-share:*` credits; open backorder lines are cancelled "Order refunded".
 *
 * NOT ported (and why):
 *   - affiliate commission reversal, fiscal credit notes / refund receipts, GL journal reversal, warehouse-stock
 *     reconcile, refund e-mail/push/WhatsApp notifications, cache busts: not DO money state (platform DB / queues);
 *   - the pro-rata wallet share of a GATEWAY partial refund (`creditReturnWalletShare` amount maths lives in the
 *     return flow with the gateway legs): pass `walletCredit` for a store-credit refund instead;
 *   - the pre-2026-09-30 admin-order coupon cutover (DO orders always reserve their coupon) and the single-line
 *     backorder cancel/heal (`cancelBackorder`): this slice cancels open lines for a whole-order event only;
 *   - the Return row lifecycle (`returns`/`return_items` status) and tier/B2B return adjustments live in `do/returns.ts` (CF-RETURNS-1).
 * Hardening vs the original: a partial line that does not belong to the order is REFUSED (the original skips it), and a
 * partial restock is capped at the line's REMAINING restorable quantity, not just its quantity.
 */

const PARTIAL_RESTORE_MARKER = 'partial_return_restored';
const PARTIAL_REFUND_MARKER = 'partial_refund_recorded';
const BACKORDER_CANCEL_MARKER = 'backorder_line_cancelled';
const BACKORDER_RELEASE_HEAL_MARKER = 'backorder_release_healed';
const LEGACY_ROLLBACK_REASON = 'Order rollback — payment step failed';
const RETURN_WALLET_SHARE_KEY_PREFIX = 'return-wallet-share:';
const WALLET_MAX_ENTRY = 100_000_000;

const id = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || v.length < 1 || v.length > 200)
    throw new MoneyError('BAD_ID', `${name} is required`, 400);
  return v;
};

// ---------------------------------------------------------------- wallet (port of WalletService.applyEntry)

export type WalletEntryType =
  | 'credit'
  | 'debit'
  | 'refund_credit'
  | 'order_payment'
  | 'order_payment_reversal'
  | 'admin_adjust'
  | 'expire';

export interface WalletEntryResult {
  balance: number;
  replayed: boolean;
}

/**
 * One signed ledger entry, idempotent on `(store, idempotencyKey)`. A key reused for a DIFFERENT movement is refused.
 * The balance never goes below zero: a debit is one conditional UPDATE (`balance + amount >= 0`).
 */
export function applyWalletEntry(
  db: SyncSql,
  a: {
    storeId: string;
    customerId: string;
    amount: number;
    type: WalletEntryType;
    idempotencyKey: string;
    orderId?: string | null;
    returnId?: string | null;
    actorId?: string | null;
    note?: string | null;
    now?: number;
  }
): WalletEntryResult {
  id(a.storeId, 'storeId');
  id(a.customerId, 'customerId');
  if (!Number.isSafeInteger(a.amount) || a.amount === 0 || Math.abs(a.amount) > WALLET_MAX_ENTRY)
    throw new MoneyError(
      'INVALID_WALLET_AMOUNT',
      'amount must be a non-zero whole number of piastres within the single-movement limit',
      400
    );
  if (!a.idempotencyKey || a.idempotencyKey.length > 200)
    throw new MoneyError('INVALID_IDEMPOTENCY_KEY', 'a wallet write needs an idempotency key', 400);
  const now = a.now ?? Date.now();

  return db.transactionSync(() => {
    const prior = db.all(
      'SELECT customer_id, amount, type, balance_after FROM wallet_transactions WHERE store_id = ? AND idempotency_key = ?',
      [a.storeId, a.idempotencyKey]
    )[0];
    if (prior) {
      if (prior.customer_id !== a.customerId || prior.amount !== a.amount || prior.type !== a.type)
        throw new MoneyError(
          'IDEMPOTENCY_KEY_REUSED',
          'this idempotency key was already used for a different wallet movement',
          409
        );
      const w = db.all(
        'SELECT balance FROM customer_wallets WHERE store_id = ? AND customer_id = ?',
        [a.storeId, a.customerId]
      )[0];
      return {
        balance: (w?.balance as number | undefined) ?? (prior.balance_after as number),
        replayed: true,
      };
    }

    if (a.amount > 0) {
      // `customerId` is the shopper's users.id (Ruling CF-FIX-2): a wallet belongs to the account, never to a CRM row, and
      // a credit must not be refused because the merchant has no CRM row for the shopper (the Postgres twin checks `users`).
      db.run(
        `INSERT INTO customer_wallets (id, store_id, customer_id, balance, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT (store_id, customer_id) DO NOTHING`,
        [crypto.randomUUID(), a.storeId, a.customerId, now, now]
      );
    }
    // ONE conditional statement checks AND moves the balance
    const w = db.all(
      `UPDATE customer_wallets SET balance = balance + ?1, updated_at = ?4
       WHERE store_id = ?2 AND customer_id = ?3 AND balance + ?1 >= 0 RETURNING id, balance`,
      [a.amount, a.storeId, a.customerId, now]
    )[0];
    if (!w)
      throw new MoneyError(
        'INSUFFICIENT_WALLET_BALANCE',
        'the wallet balance is not enough for this amount',
        409
      );
    const entryId = crypto.randomUUID();
    db.run(
      `INSERT INTO wallet_transactions (id, store_id, wallet_id, customer_id, amount, balance_after, type, order_id, return_id, idempotency_key, actor_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entryId,
        a.storeId,
        w.id,
        a.customerId,
        a.amount,
        w.balance,
        a.type,
        a.orderId ?? null,
        a.returnId ?? null,
        a.idempotencyKey,
        a.actorId ?? null,
        a.note ?? null,
        now,
      ]
    );
    // Ruling WALLET-GL-1: the GL row commits with the wallet row it mirrors, never on a replay
    postWalletMovementJournal(db, {
      storeId: a.storeId,
      entryId,
      type: a.type,
      amount: a.amount,
      now,
    });
    return { balance: w.balance as number, replayed: false };
  });
}

/**
 * Put an order's checkout wallet spend back, exactly once (`WalletService.reverseOrderPayment`). Reads the original
 * `order_payment` ledger row (not orders.wallet_amount), subtracts pro-rata shares partial returns already returned,
 * and credits the rest under `order-payment-reversal:<orderId>`. `null` when there is nothing to put back.
 */
export function reverseOrderPayment(
  db: SyncSql,
  a: { storeId: string; orderId: string; now?: number }
): (WalletEntryResult & { amount: number }) | null {
  return db.transactionSync(() => {
    const spend = db.all(
      `SELECT customer_id, amount FROM wallet_transactions WHERE store_id = ? AND order_id = ? AND type = 'order_payment'`,
      [a.storeId, a.orderId]
    )[0];
    if (!spend || (spend.amount as number) >= 0) return null;
    const returned = db.all(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM wallet_transactions
       WHERE store_id = ? AND order_id = ? AND type = 'refund_credit' AND substr(idempotency_key, 1, ?) = ?`,
      [a.storeId, a.orderId, RETURN_WALLET_SHARE_KEY_PREFIX.length, RETURN_WALLET_SHARE_KEY_PREFIX]
    )[0].s as number;
    const credited = db.all(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM wallet_transactions
       WHERE store_id = ? AND order_id = ? AND idempotency_key LIKE 'return-credit:%' AND amount > 0`,
      [a.storeId, a.orderId]
    )[0].s as number;
    // #624: never give back more than the order's one refundable balance leaves (a card / InstaPay / cash refund of the
    // same order may already have covered part of the wallet share)
    const planned = -(spend.amount as number) - returned - credited;
    const remaining = Math.min(planned, refundableBalance(db, a.storeId, a.orderId).refundable);
    // a trimmed give-back is recorded for review + alerted, never silent (#659 review B2)
    if (planned > 0 && remaining < planned)
      recordTrimmedCredit(db, {
        storeId: a.storeId,
        orderId: a.orderId,
        planned,
        credited: Math.max(0, remaining),
        source: 'order_reversal',
        now: a.now ?? Date.now(),
      });
    if (remaining <= 0) return null;
    const r = applyWalletEntry(db, {
      storeId: a.storeId,
      customerId: spend.customer_id as string,
      amount: remaining,
      type: 'order_payment_reversal',
      idempotencyKey: `order-payment-reversal:${a.orderId}`,
      orderId: a.orderId,
      now: a.now,
    });
    return { ...r, amount: remaining };
  });
}

// ---------------------------------------------------------------- shared helpers

interface OrderRow {
  id: string;
  customer_id: string | null;
  status: string;
  payment_status: string;
  total: number;
  coupon_code: string | null;
  refund_reversed_at: number | null;
  wallet_amount: number | null;
}

function loadOrder(db: SyncSql, storeId: string, orderId: string): OrderRow {
  const o = db.all(
    'SELECT id, customer_id, status, payment_status, total, coupon_code, refund_reversed_at, wallet_amount FROM orders WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL',
    [orderId, storeId]
  )[0];
  if (!o) throw new MoneyError('ORDER_NOT_FOUND', 'order not found', 404);
  return o as unknown as OrderRow;
}

function addEvent(
  db: SyncSql,
  storeId: string,
  orderId: string,
  from: string | null,
  to: string,
  metadata: Record<string, unknown>,
  now: number
): void {
  db.run(
    'INSERT INTO order_events (id, store_id, order_id, from_status, to_status, actor_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
    [crypto.randomUUID(), storeId, orderId, from, to, JSON.stringify(metadata), now]
  );
}

interface ItemRow {
  id: string;
  product_id: string;
  variant_id: string | null;
  quantity: number;
}

function loadItems(db: SyncSql, orderId: string): ItemRow[] {
  return db.all(
    'SELECT id, product_id, variant_id, quantity FROM order_items WHERE order_id = ? ORDER BY id',
    [orderId]
  ) as unknown as ItemRow[];
}

export interface RestockedLine {
  orderItemId: string;
  productId: string;
  variantId: string | null;
  quantity: number;
}

/** Restock one line: variant row XOR product row, never both; untracked products are left alone. Returns the qty moved. */
function restoreLine(
  db: SyncSql,
  storeId: string,
  item: ItemRow,
  qty: number,
  reference: string,
  reason: string
): number {
  const p = db.all('SELECT track_inventory FROM products WHERE id = ? AND store_id = ?', [
    item.product_id,
    storeId,
  ])[0];
  if (!p || p.track_inventory !== 1) return 0;
  let r;
  if (item.variant_id) {
    const v = db.all('SELECT id FROM product_variants WHERE id = ? AND product_id = ?', [
      item.variant_id,
      item.product_id,
    ])[0];
    if (!v) throw new MoneyError('VARIANT_NOT_FOUND', 'variant of the order line is gone', 409);
    r = restock(db, 'product_variants', item.variant_id, qty);
  } else {
    r = restock(db, 'products', item.product_id, qty);
  }
  recordMovement(db, {
    storeId,
    productId: item.product_id,
    type: 'return_stock',
    quantity: qty,
    previousStock: r.previousStock,
    newStock: r.newStock,
    reference,
    reason,
  });
  return qty;
}

/** units a partial return / backorder heal already put back, per order item (original `alreadyRestored`). */
function alreadyRestoredByItem(db: SyncSql, storeId: string, orderId: string): Map<string, number> {
  const m = new Map<string, number>();
  const bump = (k: unknown, n: unknown) => {
    if (typeof k === 'string' && typeof n === 'number' && Number.isFinite(n) && n > 0)
      m.set(k, (m.get(k) ?? 0) + n);
  };
  const parse = (s: unknown): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(String(s));
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  for (const e of db.all(
    'SELECT to_status, metadata FROM order_events WHERE store_id = ? AND order_id = ? AND to_status IN (?, ?, ?)',
    [
      storeId,
      orderId,
      PARTIAL_RESTORE_MARKER,
      BACKORDER_CANCEL_MARKER,
      BACKORDER_RELEASE_HEAL_MARKER,
    ]
  )) {
    const meta = parse(e.metadata);
    if (!meta) continue;
    const items = Array.isArray(meta.items)
      ? (meta.items as Array<{ orderItemId?: unknown; quantity?: unknown }>)
      : [];
    if (e.to_status === PARTIAL_RESTORE_MARKER) {
      for (const it of items) bump(it?.orderItemId, it?.quantity);
    } else {
      // single-line backorder cancel / release heal: only the units it really put back (`stockRestored`)
      bump(items[0]?.orderItemId, meta.stockRestored);
    }
  }
  return m;
}

// ---------------------------------------------------------------- public API

export interface RefundResult {
  orderId: string;
  kind: 'cancel' | 'refund' | 'partial_refund';
  /** true when this exact event had already been applied: nothing changed. */
  replayed: boolean;
  status: string;
  restocked: RestockedLine[];
  couponUnclaimed: boolean;
  walletReversed: number;
  walletCredited: number;
  loyalty: { earnedReversed: number; redeemedRecredited: number };
  backorderLinesCancelled: number;
  /** set when an `external` refund was recorded in full but exceeded the order or hit a state a refund would not normally reach */
  review?: string;
}

function emptyResult(o: OrderRow, kind: RefundResult['kind'], replayed: boolean): RefundResult {
  return {
    orderId: o.id,
    kind,
    replayed,
    status: o.status,
    restocked: [],
    couponUnclaimed: false,
    walletReversed: 0,
    walletCredited: 0,
    loyalty: { earnedReversed: 0, redeemedRecredited: 0 },
    backorderLinesCancelled: 0,
  };
}

/** Whole-order reversal: every step is individually idempotent (see the file header). */
function reverseWholeOrder(
  db: SyncSql,
  storeId: string,
  o: OrderRow,
  now: number,
  into: RefundResult,
  restoreInventory = true
): void {
  // arm the completion claim (applyRefundEffects), then run every reversal, then claim (claim-reversed step).
  // restoreInventory:false (a cancel whose goods are NOT going back on the shelf, MONEYB-5) is never armed, like Postgres.
  if (restoreInventory)
    db.run(
      'UPDATE orders SET refund_reversal_requested_at = ?1, refund_reversed_at = NULL, updated_at = ?1 WHERE id = ?2 AND store_id = ?3',
      [now, o.id, storeId]
    );
  else
    db.run(
      'UPDATE orders SET refund_reversed_at = NULL, updated_at = ?1 WHERE id = ?2 AND store_id = ?3',
      [now, o.id, storeId]
    );

  // the fiscal document of the reversal (credit note, or the cancelled sale), in the same section
  settleFiscalOnReversal(db, { storeId, orderId: o.id, now });

  const legacy = db.all(
    `SELECT id FROM inventory_history WHERE store_id = ? AND reference = ? AND type = 'adjustment' AND reason = ?`,
    [storeId, o.id, LEGACY_ROLLBACK_REASON]
  )[0];

  // restore-inventory
  const stockMarker = db.all(
    `SELECT id FROM inventory_history WHERE store_id = ? AND reference = ? AND (type = 'return_stock' OR (type = 'adjustment' AND reason = ?)) LIMIT 1`,
    [storeId, o.id, LEGACY_ROLLBACK_REASON]
  )[0];
  if (!stockMarker && restoreInventory) {
    const restored = alreadyRestoredByItem(db, storeId, o.id);
    const neverTaken = neverTakenByItem(db, storeId, o.id);
    for (const item of loadItems(db, o.id)) {
      const qty = item.quantity - (restored.get(item.id) ?? 0) - (neverTaken.get(item.id) ?? 0);
      if (qty <= 0) continue;
      if (restoreLine(db, storeId, item, qty, o.id, 'Order refunded') > 0)
        into.restocked.push({
          orderItemId: item.id,
          productId: item.product_id,
          variantId: item.variant_id,
          quantity: qty,
        });
    }
  }

  // reverse-coupon: its OWN marker, so a restoreInventory-less / untracked order still releases the use exactly once
  if (o.coupon_code) {
    const marker = db.all(
      `SELECT id FROM order_events WHERE store_id = ? AND order_id = ? AND to_status = 'coupon_reversed'`,
      [storeId, o.id]
    )[0];
    if (!marker && !legacy) {
      db.run(
        'UPDATE coupons SET usage_count = usage_count - 1, updated_at = ?3 WHERE store_id = ?1 AND code = ?2 AND usage_count > 0',
        [storeId, o.coupon_code, now]
      );
      addEvent(db, storeId, o.id, null, 'coupon_reversed', {}, now);
      into.couponUnclaimed = true;
    }
  }

  // reverse-loyalty (no-op for a guest order)
  if (o.customer_id) {
    const e = reverseEarnedPointsFromOrder(db, { storeId, orderId: o.id, now });
    const r = reverseRedeemedPointsFromOrder(db, { storeId, orderId: o.id, now });
    into.loyalty = {
      earnedReversed: e?.pointsReversed ?? 0,
      redeemedRecredited: r?.pointsRecredited ?? 0,
    };
  }

  // reverse-wallet-payment
  const w = reverseOrderPayment(db, { storeId, orderId: o.id, now });
  if (w && !w.replayed) into.walletReversed = w.amount;

  // cancel-backorders (whole order)
  into.backorderLinesCancelled = db.run(
    `UPDATE backorder_lines SET cancelled_at = ?1, cancelled_reason = 'Order refunded'
     WHERE store_id = ?2 AND order_item_id IN (SELECT id FROM order_items WHERE order_id = ?3)
       AND fulfilled_at IS NULL AND cancelled_at IS NULL`,
    [now, storeId, o.id]
  ).changes;

  // claim-reversed
  db.run(
    'UPDATE orders SET refund_reversed_at = ?1 WHERE id = ?2 AND store_id = ?3 AND refund_reversed_at IS NULL',
    [now, o.id, storeId]
  );
}

/**
 * Cancel an order: status `cancelled` and the full reversal. Legal from pending, awaiting_payment_confirmation,
 * confirmed, processing, shipped (a delivered order can only be refunded). Calling it again is a no-op
 * (`replayed: true`); calling it on a cancelled order whose reversal never completed finishes the reversal.
 */
export function cancelOrder(
  db: SyncSql,
  a: { storeId: string; orderId: string; now?: number; restoreInventory?: boolean }
): RefundResult {
  id(a.storeId, 'storeId');
  id(a.orderId, 'orderId');
  const now = a.now ?? Date.now();
  return db.transactionSync(() => {
    const o = loadOrder(db, a.storeId, a.orderId);
    if (o.status === 'refunded') return emptyResult(o, 'cancel', true); // refunded is terminal
    if (o.status === 'cancelled' && o.refund_reversed_at !== null)
      return emptyResult(o, 'cancel', true);
    if (o.status === 'delivered')
      throw new MoneyError(
        'INVALID_TRANSITION',
        'a delivered order cannot be cancelled; refund it',
        409
      );
    const out = emptyResult(o, 'cancel', false);
    if (o.status !== 'cancelled') {
      db.run(
        "UPDATE orders SET status = 'cancelled', updated_at = ?1 WHERE id = ?2 AND store_id = ?3",
        [now, o.id, a.storeId]
      );
      addEvent(db, a.storeId, o.id, o.status, 'cancelled', {}, now);
      out.status = 'cancelled';
    }
    reverseWholeOrder(db, a.storeId, o, now, out, a.restoreInventory !== false);
    return out;
  });
}

/** Units a backordered line never took from stock (qty - stock_taken - qty_fulfilled): they must never be restocked. */
function neverTakenByItem(db: SyncSql, storeId: string, orderId: string): Map<string, number> {
  const neverTaken = new Map<string, number>();
  for (const bl of db.all(
    `SELECT order_item_id, qty, stock_taken, qty_fulfilled FROM backorder_lines
     WHERE store_id = ? AND order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)`,
    [storeId, orderId]
  )) {
    const qty = bl.qty as number;
    const untaken = Math.max(
      0,
      qty - ((bl.stock_taken as number | null) ?? qty) - ((bl.qty_fulfilled as number | null) ?? 0)
    );
    if (untaken > 0)
      neverTaken.set(
        bl.order_item_id as string,
        (neverTaken.get(bl.order_item_id as string) ?? 0) + untaken
      );
  }
  return neverTaken;
}

export interface PartialLine {
  orderItemId: string;
  quantity: number;
}

/**
 * The whole-order effects of a FULL return completed by a manual method (stock back, coupon, loyalty, wallet spend, backorders),
 * with the order status UNTOUCHED, like the `order/refunded` fanout the Postgres path sends (Ruling CF-RETURNS-1). Idempotent.
 */
export function reverseOrderEffects(
  db: SyncSql,
  a: { storeId: string; orderId: string; now?: number }
): RefundResult {
  const now = a.now ?? Date.now();
  return db.transactionSync(() => {
    const o = loadOrder(db, a.storeId, a.orderId);
    const out = emptyResult(o, 'refund', false);
    reverseWholeOrder(db, a.storeId, o, now, out);
    return out;
  });
}

/**
 * Refund an order.
 *   neither `lines` nor `amount`: FULL refund. Status `refunded` (payment_status `refunded` if it was paid/disputed)
 *     and the full reversal; legal from confirmed, processing, shipped, delivered, cancelled.
 *   `lines` (item-level return) and/or `amount` (amount-only, e.g. a provider-dashboard partial): PARTIAL. Needs a
 *     caller `refundKey` (the Return id / provider refund id); the status is untouched and nothing whole-order runs.
 *     `lines` restock exactly those quantities; `walletCredit` (store credit) is credited once under
 *     `return-credit:<refundKey>`. `amount` is recorded and bounded by the order total across all partial events.
 * Replays (same state, same refundKey) return `replayed: true` and change nothing.
 */
export function refundOrder(
  db: SyncSql,
  a: {
    storeId: string;
    orderId: string;
    amount?: number;
    lines?: PartialLine[];
    refundKey?: string;
    walletCredit?: number;
    /**
     * The provider or the merchant ALREADY refunded this money (a completed gateway refund, a dashboard refund): an
     * external fact, recorded in full and never rejected (CF-PAY-1). The ceiling and the order-state checks do not throw;
     * the full amount is stored on the marker and `review` is set so the surplus or the state is visible.
     */
    external?: boolean;
    keepPaymentStatus?: boolean;
    now?: number;
  }
): RefundResult {
  id(a.storeId, 'storeId');
  id(a.orderId, 'orderId');
  const now = a.now ?? Date.now();
  const partial = a.lines !== undefined || a.amount !== undefined || a.walletCredit !== undefined;

  if (!partial) {
    return db.transactionSync(() => {
      const o = loadOrder(db, a.storeId, a.orderId);
      if (o.status === 'refunded' && o.refund_reversed_at !== null)
        return emptyResult(o, 'refund', true);
      if (o.status === 'pending' || o.status === 'awaiting_payment_confirmation')
        throw new MoneyError(
          'INVALID_TRANSITION',
          'an order that was never confirmed cannot be refunded; cancel it',
          409
        );
      const out = emptyResult(o, 'refund', false);
      if (o.status !== 'refunded') {
        // `keepPaymentStatus`: a merchant status change leaves `payment_status` alone, like OrderService.updateStatus; a provider refund
        // flips it (the gateway paths write status AND payment_status together)
        db.run(
          `UPDATE orders SET status = 'refunded', payment_status = CASE WHEN ?4 = 0 AND payment_status IN ('paid', 'disputed') THEN 'refunded' ELSE payment_status END, updated_at = ?1
           WHERE id = ?2 AND store_id = ?3`,
          [now, o.id, a.storeId, a.keepPaymentStatus ? 1 : 0]
        );
        addEvent(db, a.storeId, o.id, o.status, 'refunded', {}, now);
        out.status = 'refunded';
      }
      reverseWholeOrder(db, a.storeId, o, now, out);
      return out;
    });
  }

  // ------------------------------------------------------------ partial
  const key = a.refundKey;
  if (typeof key !== 'string' || key.length < 1 || key.length > 150)
    throw new MoneyError(
      'BAD_REFUND_KEY',
      'a partial refund needs a refundKey (the return id / provider refund id)',
      400
    );
  if (a.lines !== undefined) {
    if (!Array.isArray(a.lines) || a.lines.length < 1 || a.lines.length > 100)
      throw new MoneyError('BAD_LINES', 'lines must hold 1 to 100 entries', 400);
    const seen = new Set<string>();
    for (const l of a.lines) {
      if (
        !l ||
        typeof l.orderItemId !== 'string' ||
        !Number.isInteger(l.quantity) ||
        l.quantity < 1 ||
        l.quantity > 100_000
      )
        throw new MoneyError(
          'BAD_QUANTITY',
          'each line needs an orderItemId and an integer quantity',
          400
        );
      if (seen.has(l.orderItemId)) throw new MoneyError('BAD_LINES', 'a line is listed twice', 400);
      seen.add(l.orderItemId);
    }
  }
  const amountOk = (v: unknown, name: string): number => {
    if (!Number.isSafeInteger(v) || (v as number) < 1)
      throw new MoneyError('BAD_AMOUNT', `${name} must be a positive integer of piastres`, 400);
    return v as number;
  };
  const amount = a.amount === undefined ? undefined : amountOk(a.amount, 'amount');
  const walletCredit =
    a.walletCredit === undefined ? undefined : amountOk(a.walletCredit, 'walletCredit');
  if (a.lines === undefined && amount === undefined && walletCredit === undefined)
    throw new MoneyError('BAD_REFUND', 'nothing to refund', 400);

  return db.transactionSync(() => {
    const o = loadOrder(db, a.storeId, a.orderId);
    const out = emptyResult(o, 'partial_refund', false);
    const marker = a.lines !== undefined ? PARTIAL_RESTORE_MARKER : PARTIAL_REFUND_MARKER;
    const done = db.all(
      `SELECT id FROM order_events WHERE store_id = ? AND order_id = ? AND to_status IN (?, ?) AND json_extract(metadata, '$.refundKey') = ?`,
      [a.storeId, a.orderId, PARTIAL_RESTORE_MARKER, PARTIAL_REFUND_MARKER, key]
    )[0];
    if (done) return { ...out, replayed: true };
    let review: string | null = null;
    if (o.status === 'cancelled' || o.status === 'refunded') {
      if (!a.external)
        throw new MoneyError(
          'ORDER_ALREADY_REVERSED',
          'the order is already cancelled or refunded',
          409
        );
      review = 'order_already_reversed';
    } else if (o.status === 'pending' || o.status === 'awaiting_payment_confirmation') {
      if (!a.external)
        throw new MoneyError(
          'INVALID_TRANSITION',
          'an unconfirmed order has nothing to refund',
          409
        );
      review = 'order_not_confirmed';
    }

    // Two ceilings, same transaction as the writes below (two partials racing at the boundary cannot both win):
    //  - amount-only bookings (provider/cash amounts recorded on events) stay bounded by what the order captured;
    //  - store credit is bounded by the order's ONE refundable balance across every channel (#624: card, InstaPay,
    //    store credit, wallet give-backs, cash returns), so it can never be paid on top of a card refund of the same money.
    const priorAmount = db.all(
      `SELECT COALESCE(SUM(json_extract(metadata, '$.amount')), 0) AS s FROM order_events
       WHERE store_id = ? AND order_id = ? AND to_status IN (?, ?)`,
      [a.storeId, a.orderId, PARTIAL_RESTORE_MARKER, PARTIAL_REFUND_MARKER]
    )[0].s as number;
    const captured =
      o.payment_status === 'paid' || o.payment_status === 'disputed'
        ? o.total
        : (o.wallet_amount ?? 0);
    const bal = refundableBalance(db, a.storeId, a.orderId);
    // an EXTERNAL amount is already mirrored on payments.refunded_amount (counted in `bal`); a merchant-booked one is not
    const adds = (a.external ? 0 : (amount ?? 0)) + (walletCredit ?? 0);
    if (priorAmount + (amount ?? 0) > captured || adds > bal.refundable || bal.refundable < 0) {
      if (a.external) review = review ?? 'refund_exceeds_order';
      else
        throw new MoneyError(
          'REFUND_EXCEEDS_ORDER',
          'refunds and store credit would exceed what the customer paid',
          409,
          { captured, prior: priorAmount, refundable: Math.max(0, bal.refundable) }
        );
    }

    const restored: Array<{ orderItemId: string; quantity: number }> = [];
    if (a.lines !== undefined) {
      const items = new Map(loadItems(db, o.id).map(i => [i.id, i]));
      const already = alreadyRestoredByItem(db, a.storeId, o.id);
      const neverTaken = neverTakenByItem(db, a.storeId, o.id);
      // validate every line before moving any stock (the unit is atomic anyway, this gives the clearer error)
      for (const l of a.lines)
        if (!items.has(l.orderItemId))
          throw new MoneyError('UNKNOWN_LINE', 'a listed line does not belong to this order', 400);
      for (const l of a.lines) {
        const item = items.get(l.orderItemId)!;
        const qty = Math.min(
          l.quantity,
          item.quantity - (already.get(item.id) ?? 0) - (neverTaken.get(item.id) ?? 0)
        );
        if (qty <= 0) continue;
        if (restoreLine(db, a.storeId, item, qty, key, 'Return completed — partial restore') > 0)
          out.restocked.push({
            orderItemId: item.id,
            productId: item.product_id,
            variantId: item.variant_id,
            quantity: qty,
          });
        restored.push({ orderItemId: item.id, quantity: qty });
      }
    }
    if (walletCredit !== undefined) {
      if (!o.customer_id)
        throw new MoneyError('NO_CUSTOMER', 'a guest order has no wallet to credit', 400);
      const r = applyWalletEntry(db, {
        storeId: a.storeId,
        customerId: o.customer_id,
        amount: walletCredit,
        type: 'refund_credit',
        idempotencyKey: `return-credit:${key}`,
        orderId: o.id,
        now,
      });
      if (!r.replayed) out.walletCredited = walletCredit;
    }
    addEvent(
      db,
      a.storeId,
      o.id,
      null,
      marker,
      {
        refundKey: key,
        items: restored,
        ...(amount !== undefined ? { amount } : {}),
        ...(walletCredit !== undefined ? { walletCredit } : {}),
        // mirrored on payments.refunded_amount: refundableBalance must not count this amount a second time
        ...(a.external ? { external: true } : {}),
        ...(review ? { review } : {}),
      },
      now
    );
    if (review) out.review = review;
    return out;
  });
}
