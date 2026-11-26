import { MoneyError, type SyncSql } from './sync-sql';

/**
 * ONE refundable balance per order, across EVERY refund channel (#624, foundation rule "one refundable balance, all
 * channels"). Before this, each channel had its own ceiling: the card cap (`beginRefund`) read only
 * `payments.refunded_amount`, a store-credit return read only the return's own allocation, so a full card refund plus a
 * store-credit return of the same goods paid the order out twice.
 *
 *   paid      = the order total when it was captured (payment_status paid / disputed / refunded), else only the wallet
 *               share it actually spent (the larger of `orders.wallet_amount` and the ledger's `order_payment` debit)
 *   refunded  = provider + InstaPay + recorded manual refunds   SUM(payments.refunded_amount)   (open claims included:
 *                                                               a claimed refund is money that may already have left)
 *             + store credit and wallet give-backs             wallet_transactions refund_credit / order_payment_reversal
 *             + manual return payouts                          completed returns with cash / bank_transfer / manual
 *   refundable = paid - refunded
 *
 *             + amounts the merchant booked on the order         partial-refund order events WITHOUT `external`
 * A provider/settlement booking's amount mirrors a `payments.refunded_amount` move, so it is not counted twice: it is
 * recognised by its refundKey being a provider refund id on the order's payments (`metadata.refundEventIds`), or by the
 * `external: true` flag new bookings also carry. Events written before #624 are therefore classified exactly. Callers read this INSIDE the same `transactionSync` as their write; the
 * StoreDO runs one section at a time, so two refunds racing at the boundary cannot both pass.
 */
export const MANUAL_RETURN_METHODS = ['cash', 'bank_transfer', 'manual'] as const;

interface RefundableBalance {
  paid: number;
  refunded: number;
  refundable: number;
  byChannel: { provider: number; storeCredit: number; manualReturn: number; bookedAmount: number };
}

const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0)) || 0;

export function refundableBalance(
  db: SyncSql,
  storeId: string,
  orderId: string
): RefundableBalance {
  const o = db.all(
    'SELECT payment_status, total, wallet_amount FROM orders WHERE id = ?1 AND store_id = ?2',
    [orderId, storeId]
  )[0];
  if (!o) throw new MoneyError('ORDER_NOT_FOUND', 'order not found', 404);
  const walletSpent = -n(
    db.all(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM wallet_transactions
        WHERE store_id = ?1 AND order_id = ?2 AND type = 'order_payment' AND amount < 0`,
      [storeId, orderId]
    )[0]?.s
  );
  const captured = ['paid', 'disputed', 'refunded'].includes(String(o.payment_status));
  const paid = captured ? n(o.total) : Math.max(n(o.wallet_amount), walletSpent);
  const provider = n(
    db.all(
      `SELECT COALESCE(SUM(p.refunded_amount), 0) AS s FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE o.store_id = ?1 AND p.order_id = ?2`,
      [storeId, orderId]
    )[0]?.s
  );
  const storeCredit = n(
    db.all(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM wallet_transactions
        WHERE store_id = ?1 AND order_id = ?2 AND amount > 0 AND type IN ('refund_credit', 'order_payment_reversal')`,
      [storeId, orderId]
    )[0]?.s
  );
  const manualReturn = n(
    db.all(
      `SELECT COALESCE(SUM(refund_amount), 0) AS s FROM returns
        WHERE store_id = ?1 AND order_id = ?2 AND status = 'completed' AND type <> 'exchange'
          AND refund_method IN (?3, ?4, ?5)`,
      [storeId, orderId, ...MANUAL_RETURN_METHODS]
    )[0]?.s
  );
  // an amount the MERCHANT booked on the order (refundBook with `amount`). A provider/settlement booking is the SAME money
  // as a `payments.refunded_amount` move, and is recognised from the data, not only from a flag: its refundKey is the
  // provider refund id, which both writers (completeRefund, the settle webhook) append to that payment's
  // `metadata.refundEventIds`. So events written before the `external` flag existed are classified exactly too.
  const bookedAmount = n(
    db.all(
      `SELECT COALESCE(SUM(json_extract(e.metadata, '$.amount')), 0) AS s FROM order_events e
        WHERE e.store_id = ?1 AND e.order_id = ?2 AND e.to_status IN ('partial_return_restored', 'partial_refund_recorded')
          AND json_extract(e.metadata, '$.external') IS NOT 1
          AND NOT EXISTS (
            SELECT 1 FROM payments p, json_each(COALESCE(json_extract(p.metadata, '$.refundEventIds'), '[]')) j
             WHERE p.order_id = e.order_id AND j.value = json_extract(e.metadata, '$.refundKey'))`,
      [storeId, orderId]
    )[0]?.s
  );
  const refunded = provider + storeCredit + manualReturn + bookedAmount;
  return {
    paid,
    refunded,
    refundable: paid - refunded,
    byChannel: { provider, storeCredit, manualReturn, bookedAmount },
  };
}

/** Refuse `amount` more out of this order when it would take the order past what was paid (409, nothing written). */
export function assertRefundable(
  db: SyncSql,
  storeId: string,
  orderId: string,
  amount: number
): RefundableBalance {
  const b = refundableBalance(db, storeId, orderId);
  if (amount > b.refundable) throw exceeds(b, amount);
  return b;
}

/**
 * The invariant a refund writer ends its section with: what went out never exceeds what came in. A throw here rolls
 * the whole section back (the write that broke it included). With `before` (read at the top of the same section) only a
 * section that ADDED refunds is refused, so an order already over the line from older data does not block a zero-money
 * completion.
 */
export function assertWithinPaid(
  db: SyncSql,
  storeId: string,
  orderId: string,
  before?: RefundableBalance
): void {
  const b = refundableBalance(db, storeId, orderId);
  if (b.refundable < 0 && (!before || b.refunded > before.refunded))
    throw exceeds(b, b.refunded - (before?.refunded ?? 0));
}

function exceeds(b: RefundableBalance, amount: number): MoneyError {
  return new MoneyError(
    'REFUND_EXCEEDS_ORDER',
    'This would refund more than the customer paid for the order. Earlier refunds (card, InstaPay, store credit or a cash return) already cover part of it.',
    409,
    { paid: b.paid, refunded: b.refunded, refundable: Math.max(0, b.refundable), requested: amount }
  );
}

// ---------------------------------------------------------------- trimmed give-backs (#659 review B2)

/** A money fact the Worker must alert on after the operation commits (drained by `runMoneyOp`). */
interface MoneyAlert {
  kind: string;
  orderId: string;
  body: string;
  context?: Record<string, unknown>;
}

// The StoreDO runs one operation at a time, synchronously: this list only ever holds the CURRENT operation's alerts.
// `runMoneyOp` empties it before the operation and hands it out only if the operation committed.
const pendingAlerts: MoneyAlert[] = [];

export function takeMoneyAlerts(): MoneyAlert[] {
  return pendingAlerts.splice(0);
}

const WALLET_TRIM_REASON = 'wallet_giveback_trimmed';

/**
 * The ceiling trimmed a wallet give-back the plan said the customer is owed (`planned`) to what the order had left
 * (`credited`). Never silent: a `refund_reconcile_review` payment event on the order's newest payment (the merchant sees
 * it on the order page's payment timeline, with planned / credited / short), and a store-scoped platform alert after
 * the commit, so the difference is settled by a person.
 */
export function recordTrimmedCredit(
  db: SyncSql,
  a: {
    storeId: string;
    orderId: string;
    planned: number;
    credited: number;
    source: 'order_reversal' | 'return_wallet_share';
    now: number;
  }
): void {
  const short = a.planned - a.credited;
  if (short <= 0) return;
  const details = {
    reason: WALLET_TRIM_REASON,
    source: a.source,
    planned: a.planned,
    credited: a.credited,
    short,
  };
  const p = db.all(
    `SELECT p.id, p.provider FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE o.store_id = ?1 AND p.order_id = ?2 ORDER BY p.created_at DESC, p.id DESC LIMIT 1`,
    [a.storeId, a.orderId]
  )[0];
  if (p)
    db.run(
      `INSERT INTO payment_events (id, payment_id, store_id, order_id, event_type, from_status, to_status, provider, provider_payload, details, triggered_by_user_id, occurred_at, created_at)
       VALUES (?, ?, ?, ?, 'refund_reconcile_review', NULL, NULL, ?, NULL, ?, NULL, ?, ?)`,
      [
        crypto.randomUUID(),
        p.id,
        a.storeId,
        a.orderId,
        p.provider ?? null,
        JSON.stringify(details),
        a.now,
        a.now,
      ]
    );
  pendingAlerts.push({
    kind: WALLET_TRIM_REASON,
    orderId: a.orderId,
    body: `Order ${a.orderId}: a wallet give-back of ${a.planned} piastres was trimmed to ${a.credited} because the order's refunds already reach what the customer paid. ${short} piastres need a person to settle with the customer.`,
    context: details,
  });
}
