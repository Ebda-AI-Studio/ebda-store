// Small store-side statements the background jobs need (INFRA-CF-1, Ruling CF-JOBS-4): a job on a store that lives on its
// Durable Object cannot reach `payment_events`, `orders` stamps or the ledger totals through the read client, so each is one
// named money operation. Every statement is scoped by `store_id` taken from the DO (never from the caller).
import { MoneyError, type SyncSql } from './sync-sql';
import { addPaymentEvent } from './payments';

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || v.length === 0 || v.length > 128)
    throw new MoneyError('BAD_ARGS', what, 400);
  return v;
};

/**
 * Append one audit row to a payment's timeline (`recordPaymentEvent`). The payment must belong to this store and to the
 * named order, so a job cannot write a row against another store's payment.
 */
export function recordPaymentEventOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { recorded: true } {
  const paymentId = str(a.paymentId, 'paymentId');
  const orderId = str(a.orderId, 'orderId');
  const eventType = str(a.eventType, 'eventType');
  // `payments` carries no store column: it is scoped through its order
  const p = db.all(
    'SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = ? AND p.order_id = ? AND o.store_id = ?',
    [paymentId, orderId, storeId]
  )[0];
  if (!p) throw new MoneyError('PAYMENT_NOT_FOUND', 'payment not found', 404);
  addPaymentEvent(db, {
    storeId,
    paymentId,
    orderId,
    eventType,
    from: typeof a.fromStatus === 'string' ? a.fromStatus : null,
    to: typeof a.toStatus === 'string' ? a.toStatus : null,
    provider: typeof a.provider === 'string' ? a.provider : null,
    details: (a.details as Record<string, unknown> | undefined) ?? {},
    now: Date.now(),
  });
  return { recorded: true };
}

/**
 * Stamp "this checkout was abandoned at the gateway" exactly once: only while the order is still unpaid and unstamped
 * (the sweep's own guard). `stamped` is false when a payment or an earlier tick got there first.
 */
export function abandonStampOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { stamped: boolean } {
  const orderId = str(a.orderId, 'orderId');
  const r = db.run(
    "UPDATE orders SET payment_gateway_abandoned_at = ?1 WHERE id = ?2 AND store_id = ?3 AND payment_status = 'unpaid' AND payment_gateway_abandoned_at IS NULL",
    [Date.now(), orderId, storeId]
  );
  return { stamped: r.changes > 0 };
}

/** Sum of posted debits and credits of this store: the trial balance the daily close compares (Postgres: the raw SUM). */
export function trialBalanceOp(db: SyncSql, storeId: string): { debit: number; credit: number } {
  const r = db.all(
    `SELECT COALESCE(SUM(l.debit), 0) AS d, COALESCE(SUM(l.credit), 0) AS c
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.store_id = ? AND e.status = 'posted'`,
    [storeId]
  )[0];
  return { debit: Number(r?.d ?? 0), credit: Number(r?.c ?? 0) };
}

/** Revenue-side GL credits (sales 4000, 4010, tax payable 2100) posted since `sinceMs`: the period reconciliation's GL half. */
export function periodGlCreditsOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { total: number } {
  if (typeof a.sinceMs !== 'number' || !Number.isFinite(a.sinceMs))
    throw new MoneyError('BAD_ARGS', 'sinceMs', 400);
  const r = db.all(
    `SELECT COALESCE(SUM(l.credit), 0) AS total
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE e.store_id = ? AND e.status = 'posted' AND e.posted_at >= ? AND a.code IN ('4000', '4010', '2100')`,
    [storeId, a.sinceMs]
  )[0];
  return { total: Number(r?.total ?? 0) };
}

/**
 * Per-account debit / credit totals of the counted journal entries (posted or reversed, never draft) inside the optional
 * `[fromMs, toMs]` posted-at window, every account of the store listed (zero totals for an account with no lines): the
 * twin of `accountTotals` in `reports.service.ts`, which the profit & loss, the trial balance and the profit-anomaly scan
 * read (Ruling CF-JOBS-4).
 */
export function accountTotalsOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): {
  rows: Array<{
    id: string;
    code: string;
    nameEn: string;
    nameAr: string | null;
    type: string;
    debit: number;
    credit: number;
  }>;
} {
  const bound = (v: unknown, what: string): number | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new MoneyError('BAD_ARGS', what, 400);
    return v;
  };
  const from = bound(a.fromMs, 'fromMs');
  const to = bound(a.toMs, 'toMs');
  const filters = ["e.status IN ('posted', 'reversed')"];
  const params: unknown[] = [storeId];
  if (from !== undefined) {
    filters.push('e.posted_at >= ?');
    params.push(from);
  }
  if (to !== undefined) {
    filters.push('e.posted_at <= ?');
    params.push(to);
  }
  const rows = db.all(
    `SELECT a.id AS id, a.code AS code, a.name_en AS name_en, a.name_ar AS name_ar, a.type AS type,
            COALESCE(t.d, 0) AS d, COALESCE(t.c, 0) AS c
       FROM accounts a
       LEFT JOIN (
         SELECT l.account_id AS account_id, SUM(l.debit) AS d, SUM(l.credit) AS c
           FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
          WHERE e.store_id = ? AND ${filters.join(' AND ')}
          GROUP BY l.account_id
       ) t ON t.account_id = a.id
      WHERE a.store_id = ?
      ORDER BY a.code ASC`,
    [storeId, ...params.slice(1), storeId]
  );
  return {
    rows: rows.map(r => ({
      id: r.id as string,
      code: r.code as string,
      nameEn: r.name_en as string,
      nameAr: (r.name_ar as string | null) ?? null,
      type: r.type as string,
      debit: Number(r.d ?? 0),
      credit: Number(r.c ?? 0),
    })),
  };
}

/**
 * Customer Intelligence stamp of an order's delivery area and buyer key (the DO twin of `prismaCiSource.stampOrder`): sets
 * each only where BOTH are still null, so a second delivery of the capture job stamps nothing (Ruling CF-JOBS-4).
 */
export function ciOrderStampOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { stamped: boolean } {
  const orderId = str(a.orderId, 'orderId');
  const area = a.areaKey === null || a.areaKey === undefined ? null : str(a.areaKey, 'areaKey');
  const buyer =
    a.buyerKey === null || a.buyerKey === undefined ? null : str(a.buyerKey, 'buyerKey');
  const r = db.run(
    // fills only what is still NULL (never overwrites a stamped value): the WhatsApp RPC stamps the buyer key at creation and the CI planner
    // adds the area key later (Ruling WA-RPC-4)
    'UPDATE orders SET area_key = COALESCE(area_key, ?1), buyer_key = COALESCE(buyer_key, ?2) WHERE id = ?3 AND store_id = ?4 AND (area_key IS NULL OR buyer_key IS NULL)',
    [area, buyer, orderId, storeId]
  );
  return { stamped: r.changes > 0 };
}

/**
 * The reorder scan's first transaction (Postgres: two UPDATEs and a COUNT): expire open suggestions older than `thresholdMs`
 * and those whose unit no longer exists (a product-level row for a product that has variants, a row of a disabled variant).
 * Returns the number expired and the count of open PO lines with no variant on a variant product (logged, issue 2345).
 */
export function reorderExpireOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { expired: number; variantlessOpenPoLines: number } {
  if (typeof a.thresholdMs !== 'number' || !Number.isFinite(a.thresholdMs))
    throw new MoneyError('BAD_ARGS', 'thresholdMs', 400);
  return db.transactionSync(() => {
    const stale = db.run(
      "UPDATE reorder_suggestions SET status = 'expired' WHERE store_id = ? AND status = 'open' AND scanned_at < ?",
      [storeId, a.thresholdMs]
    ).changes;
    const gone = db.run(
      `UPDATE reorder_suggestions SET status = 'expired'
        WHERE store_id = ? AND status = 'open' AND (
          (variant_id IS NULL AND EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = reorder_suggestions.product_id))
          OR (variant_id IS NOT NULL AND EXISTS (SELECT 1 FROM product_variants pv WHERE pv.id = reorder_suggestions.variant_id AND pv.is_active = 0))
        )`,
      [storeId]
    ).changes;
    const v = db.all(
      `SELECT COUNT(*) AS n FROM purchase_order_items i JOIN purchase_orders p ON p.id = i.po_id
        WHERE p.store_id = ? AND p.status IN ('sent', 'partial') AND i.variant_id IS NULL AND i.qty > i.qty_received
          AND EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = i.product_id)`,
      [storeId]
    )[0];
    return { expired: stale + gone, variantlessOpenPoLines: Number(v?.n ?? 0) };
  });
}

interface ReorderRow {
  productId: string;
  variantId: string | null;
  suggestedQty: number;
  velocity7d: number;
  velocity28d: number;
  onHand: number;
  onOrder: number;
  openBacklog: number;
  urgencyDays: number;
  supplierId: string | null;
  reasoningEn: string;
  reasoningAr: string | null;
}

/**
 * The reorder scan's third phase: ONE open suggestion per unit. The latest open row of the unit is updated (and re-stamped
 * with this scan's time), else a row is created. Returns how many units were written; a unit that cannot be written (a
 * deleted product) is skipped, like the Postgres savepoint.
 */
export function reorderUpsertOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { upserted: number } {
  if (typeof a.scannedAtMs !== 'number' || !Array.isArray(a.items) || a.items.length > 200)
    throw new MoneyError('BAD_ARGS', 'items', 400);
  const scannedAt = a.scannedAtMs;
  let upserted = 0;
  for (const raw of a.items as ReorderRow[]) {
    try {
      db.transactionSync(() => {
        const vid = raw.variantId ?? null;
        const existing = db.all(
          `SELECT id FROM reorder_suggestions WHERE store_id = ? AND product_id = ? AND ${vid === null ? 'variant_id IS NULL' : 'variant_id = ?'} AND status = 'open' ORDER BY scanned_at DESC LIMIT 1`,
          vid === null ? [storeId, raw.productId] : [storeId, raw.productId, vid]
        )[0];
        const vals = [
          raw.suggestedQty,
          raw.velocity7d,
          raw.velocity28d,
          raw.onHand,
          raw.onOrder,
          raw.openBacklog,
          raw.urgencyDays,
          raw.supplierId ?? null,
          raw.reasoningEn,
          raw.reasoningAr ?? null,
          scannedAt,
        ];
        if (existing) {
          db.run(
            `UPDATE reorder_suggestions SET suggested_qty = ?, velocity_7d = ?, velocity_28d = ?, on_hand = ?, on_order = ?, open_backlog = ?, urgency_days = ?, supplier_id = ?, reasoning_en = ?, reasoning_ar = ?, status = 'open', scanned_at = ? WHERE id = ? AND store_id = ?`,
            [...vals, existing.id as string, storeId]
          );
        } else {
          db.run(
            `INSERT INTO reorder_suggestions (id, store_id, product_id, variant_id, suggested_qty, velocity_7d, velocity_28d, on_hand, on_order, open_backlog, urgency_days, supplier_id, reasoning_en, reasoning_ar, status, scanned_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
            [crypto.randomUUID(), storeId, raw.productId, vid, ...vals]
          );
        }
      });
      upserted += 1;
    } catch {
      // a unit whose product or supplier is gone: skipped, as the Postgres savepoint does
    }
  }
  return { upserted };
}

// ---------------------------------------------------------------------------------------------------------------------
// The order fan-out jobs (order-created, order-status-changed, order-refunded; Ruling CF-JOBS-4). Each takes a CLAIM that
// the Postgres version took with an `updateMany` / an `order_events` marker under `FOR UPDATE`; on the DO a claim is one
// conditional statement in one section, so two deliveries of the same event claim once.
// ---------------------------------------------------------------------------------------------------------------------

/** order-created fan-out: claim the customer notification exactly once (`order_created_notified_at` was NULL). */
export function orderNotifyClaimOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { claimed: boolean } {
  const r = db.run(
    'UPDATE orders SET order_created_notified_at = ? WHERE id = ? AND store_id = ? AND order_created_notified_at IS NULL',
    [Date.now(), str(a.orderId, 'orderId'), storeId]
  );
  return { claimed: r.changes > 0 };
}

/** order-status-changed fan-out: claim the transition that is still the order's current status. */
export function statusFanoutClaimOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { claimed: boolean } {
  const r = db.run(
    'UPDATE orders SET status_fanout_claimed_at = ? WHERE id = ? AND store_id = ? AND status = ? AND status_fanout_claimed_at IS NULL',
    [Date.now(), str(a.orderId, 'orderId'), storeId, str(a.status, 'status')]
  );
  return { claimed: r.changes > 0 };
}

/** ... and mark it complete (only the claimed, requested transition, once). */
export function statusFanoutCompleteOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { completed: boolean } {
  const r = db.run(
    'UPDATE orders SET status_fanout_completed_at = ? WHERE id = ? AND store_id = ? AND status_fanout_requested_status = ? AND status_fanout_claimed_at IS NOT NULL AND status_fanout_completed_at IS NULL',
    [Date.now(), str(a.orderId, 'orderId'), storeId, str(a.status, 'status')]
  );
  return { completed: r.changes > 0 };
}

const MARKER_RE = /^[a-z_]{3,40}$/;
/** An `order_events` marker taken at most once (the cancel-notice claim): true when THIS call took it. */
export function markerClaimOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { claimed: boolean } {
  const orderId = str(a.orderId, 'orderId');
  const marker = str(a.marker, 'marker');
  if (!MARKER_RE.test(marker)) throw new MoneyError('BAD_ARGS', 'marker', 400);
  return db.transactionSync(() => {
    const have = db.all(
      'SELECT id FROM order_events WHERE store_id = ? AND order_id = ? AND to_status = ?',
      [storeId, orderId, marker]
    )[0];
    if (have) return { claimed: false };
    db.run(
      "INSERT INTO order_events (id, store_id, order_id, from_status, to_status, actor_id, metadata, created_at) VALUES (?, ?, ?, NULL, ?, NULL, '{}', ?)",
      [crypto.randomUUID(), storeId, orderId, marker, Date.now()]
    );
    return { claimed: true };
  });
}

/** Give a marker back (the notice could not be sent, so a replay may send it). */
export function markerReleaseOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { released: number } {
  const marker = str(a.marker, 'marker');
  if (!MARKER_RE.test(marker)) throw new MoneyError('BAD_ARGS', 'marker', 400);
  return {
    released: db.run(
      'DELETE FROM order_events WHERE store_id = ? AND order_id = ? AND to_status = ?',
      [storeId, str(a.orderId, 'orderId'), marker]
    ).changes,
  };
}

const NOTIFY_CHANNELS = ['email', 'dispatch', 'push'];
const releasedOf = (meta: Record<string, unknown>): string[] =>
  NOTIFY_CHANNELS.filter(c => (Array.isArray(meta.released) ? meta.released : []).includes(c));

/**
 * The refund notification claim (`refund_notified` marker, per-channel release): the first call takes every channel; a
 * later call hands out only the channels a failed run released, once.
 */
export function refundNotifyClaimOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { channels: string[] } {
  const orderId = str(a.orderId, 'orderId');
  return db.transactionSync(() => {
    const sent = db.all(
      "SELECT id, metadata FROM order_events WHERE store_id = ? AND order_id = ? AND to_status = 'refund_notified'",
      [storeId, orderId]
    )[0];
    if (!sent) {
      db.run(
        "INSERT INTO order_events (id, store_id, order_id, from_status, to_status, actor_id, metadata, created_at) VALUES (?, ?, ?, NULL, 'refund_notified', NULL, '{}', ?)",
        [crypto.randomUUID(), storeId, orderId, Date.now()]
      );
      return { channels: [...NOTIFY_CHANNELS] };
    }
    const meta = JSON.parse(sent.metadata as string) as Record<string, unknown>;
    const released = releasedOf(meta);
    if (released.length === 0) return { channels: [] };
    db.run('UPDATE order_events SET metadata = ? WHERE id = ? AND store_id = ?', [
      JSON.stringify({ ...meta, released: [] }),
      sent.id as string,
      storeId,
    ]);
    return { channels: released };
  });
}

/** The customer e-mail of a refund failed: release that channel so a replay sends it. */
export function refundNotifyReleaseOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { released: string[] } {
  const orderId = str(a.orderId, 'orderId');
  const channel = str(a.channel ?? 'email', 'channel');
  if (!NOTIFY_CHANNELS.includes(channel)) throw new MoneyError('BAD_ARGS', 'channel', 400);
  return db.transactionSync(() => {
    const claim = db.all(
      "SELECT id, metadata FROM order_events WHERE store_id = ? AND order_id = ? AND to_status = 'refund_notified'",
      [storeId, orderId]
    )[0];
    if (!claim) return { released: [] };
    const meta = JSON.parse(claim.metadata as string) as Record<string, unknown>;
    const released = [...new Set([...releasedOf(meta), channel])];
    db.run('UPDATE order_events SET metadata = ? WHERE id = ? AND store_id = ?', [
      JSON.stringify({ ...meta, released }),
      claim.id as string,
      storeId,
    ]);
    return { released };
  });
}

/**
 * The refund fan-out's completion stamp: a partial refund stamps its Return's `reversal_applied_at`, a whole-order one
 * stamps `refund_reversed_at` (only when armed, unless stock is restored), each at most once.
 */
export function reversalClaimOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { claimed: boolean } {
  const now = Date.now();
  if (typeof a.returnId === 'string' && a.returnId) {
    const r = db.run(
      'UPDATE returns SET reversal_applied_at = ? WHERE id = ? AND store_id = ? AND reversal_applied_at IS NULL',
      [now, a.returnId, storeId]
    );
    return { claimed: r.changes > 0 };
  }
  const r = db.run(
    `UPDATE orders SET refund_reversed_at = ? WHERE id = ? AND store_id = ? AND refund_reversed_at IS NULL${
      a.restoreInventory === false ? ' AND refund_reversal_requested_at IS NULL' : ''
    }`,
    [now, str(a.orderId, 'orderId'), storeId]
  );
  return { claimed: r.changes > 0 };
}

/**
 * AffiliateService.processCommission's write half, in one section: the referral is claimed (`converted` with no
 * commission yet -> `commission_paid`), the affiliate's balances move and the event row is written. The Worker computed
 * `commissionAmount` from the order total and the rate. Returns false when another run claimed it first.
 */
export function affiliateCommissionOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { claimed: boolean } {
  const referralId = str(a.referralId, 'referralId');
  const amount = a.commissionAmount;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0)
    throw new MoneyError('BAD_ARGS', 'commissionAmount', 400);
  return db.transactionSync(() => {
    const ref = db.all(
      "SELECT affiliate_id, order_id FROM affiliate_referrals WHERE id = ? AND store_id = ? AND status = 'converted' AND commission_amount IS NULL",
      [referralId, storeId]
    )[0];
    if (!ref) return { claimed: false };
    db.run(
      "UPDATE affiliate_referrals SET commission_amount = ?, status = 'commission_paid' WHERE id = ? AND store_id = ?",
      [amount, referralId, storeId]
    );
    db.run(
      'UPDATE affiliates SET total_earned = total_earned + ?1, pending_balance = pending_balance + ?1 WHERE id = ?2 AND store_id = ?3',
      [amount, ref.affiliate_id as string, storeId]
    );
    addAffiliateEvent(db, storeId, ref.affiliate_id as string, 'commission_recorded', {
      orderId: ref.order_id,
      commissionAmount: amount,
      rate: a.rate ?? null,
      referralId,
    });
    return { claimed: true };
  });
}

/** AffiliateService.reverseCommission's write half (a refunded order): `commission_paid` -> `refunded`, balances back. */
export function affiliateReverseOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { amount: number | null } {
  const orderId = str(a.orderId, 'orderId');
  return db.transactionSync(() => {
    const ref = db.all(
      "SELECT id, affiliate_id, commission_amount FROM affiliate_referrals WHERE store_id = ? AND order_id = ? AND status = 'commission_paid'",
      [storeId, orderId]
    )[0];
    const amount = (ref?.commission_amount as number | null) ?? 0;
    if (!ref || !amount) return { amount: null };
    db.run(
      "UPDATE affiliate_referrals SET status = 'refunded' WHERE id = ? AND store_id = ? AND status = 'commission_paid'",
      [ref.id as string, storeId]
    );
    // the claim above is the guard: only the call that moved commission_paid -> refunded takes the money back (never twice)
    if (Number(db.all('SELECT changes() AS n', [])[0]?.n ?? 0) !== 1) return { amount: null };
    db.run(
      'UPDATE affiliates SET total_earned = total_earned - ?1, pending_balance = pending_balance - ?1 WHERE id = ?2 AND store_id = ?3',
      [amount, ref.affiliate_id as string, storeId]
    );
    addAffiliateEvent(db, storeId, ref.affiliate_id as string, 'commission_reversed', {
      orderId,
      amount,
      referralId: ref.id,
    });
    return { amount };
  });
}

/**
 * AffiliateService.createPayout on the DO: debit the pending balance (refused when it does not cover the amount), write the
 * `pending` payout row and its `payout_initiated` event, ONE section. Two concurrent payouts that each fit the balance alone
 * cannot both be paid from it (the debit re-checks it in the same section, like the Postgres `updateMany ... gte`).
 */
export function affiliatePayoutOp(
  db: SyncSql,
  storeId: string,
  a: Record<string, unknown>
): { payout: Record<string, unknown> } {
  const affiliateId = str(a.affiliateId, 'affiliateId');
  const amount = a.amount;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0)
    throw new MoneyError('INVALID_AMOUNT', 'Payout amount must be greater than zero', 400);
  const method = typeof a.method === 'string' && a.method ? a.method.slice(0, 64) : 'manual';
  const notes = typeof a.notes === 'string' ? a.notes.slice(0, 2000) : null;
  const payoutId = typeof a.payoutId === 'string' && a.payoutId ? a.payoutId : crypto.randomUUID();
  return db.transactionSync(() => {
    const found = db.all('SELECT id FROM affiliates WHERE id = ? AND store_id = ?', [
      affiliateId,
      storeId,
    ])[0];
    if (!found) throw new MoneyError('NOT_FOUND', 'Affiliate not found', 404);
    const debit = db.run(
      'UPDATE affiliates SET pending_balance = pending_balance - ?1, total_paid = total_paid + ?1 WHERE id = ?2 AND store_id = ?3 AND pending_balance >= ?1',
      [amount, affiliateId, storeId]
    );
    if (debit.changes < 1)
      throw new MoneyError('INSUFFICIENT_BALANCE', 'Payout amount exceeds pending balance', 400);
    const now = Date.now();
    db.run(
      "INSERT INTO affiliate_payouts (id, store_id, affiliate_id, amount, method, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
      [payoutId, storeId, affiliateId, amount, method, notes, now, now]
    );
    addAffiliateEvent(db, storeId, affiliateId, 'payout_initiated', { payoutId, amount, method });
    const payout = db.all('SELECT * FROM affiliate_payouts WHERE id = ?', [payoutId])[0]!;
    return {
      payout: {
        id: payout.id,
        storeId: payout.store_id,
        affiliateId: payout.affiliate_id,
        amount: payout.amount,
        method: payout.method,
        status: payout.status,
        paidAt: payout.paid_at === null ? null : new Date(payout.paid_at as number).toISOString(),
        notes: payout.notes,
        createdAt: new Date(payout.created_at as number).toISOString(),
        updatedAt: new Date(payout.updated_at as number).toISOString(),
      },
    };
  });
}

function addAffiliateEvent(
  db: SyncSql,
  storeId: string,
  affiliateId: string,
  eventType: string,
  details: Record<string, unknown>
): void {
  const now = Date.now();
  db.run(
    'INSERT INTO affiliate_events (id, affiliate_id, store_id, event_type, details, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [crypto.randomUUID(), affiliateId, storeId, eventType, JSON.stringify(details), now, now]
  );
}
