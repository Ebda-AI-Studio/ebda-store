// StoreDO payments (Phase 3.3): payment rows, the in-band refund claim -> provider -> outcome protocol, and
// `applyPaymentEvent` for payment + refund webhooks (Kashier, Paymob, Fawry) and the InstaPay merchant confirm / expiry.
// Port of apps/api/src/services/payment-providers/payment.factory.ts (PaymentService.refund claim/release, the webhook
// branches), instapay.service.ts confirm/expireOne and refund-settlement.ts (shared, one implementation).
//
// Invariants (each has a workerd concurrency test):
//   - a webhook is applied ONCE per (provider, eventId): `payment_event_log` is written in the same section as the effects;
//   - nothing the gateway has not confirmed is applied (Ruling PROVIDERS-17): a provider in CONFIRM_BEFORE_APPLY needs a
//     `confirm` dependency and ONLY its answer is applied; no answer = nothing written (the caller retries);
//   - a refund CLAIM (amount + `refund_initiated` event) is committed BEFORE the provider call; the provider id and the
//     `refund_completed` event are written together AFTER it. A settle webhook that outruns that write is reconciled
//     with the OLDEST young unconsumed claim of the same amount, which it CONSUMES in its own section (an `absorbed`
//     event carrying the claim id), so a second genuine refund of the same amount is never swallowed;
//   - the cumulative cap: a claim cannot exceed the payment's remaining balance; webhook totals only rise through
//     `resolveRefundSettlement`; partial bookings are bounded by what the order captured (refundOrder);
//   - every effect is one `transactionSync`; external I/O (provider call, confirm) happens outside it.
// Money is integer piastres. Alerts/fan-outs are RETURNED for the Worker to send after the commit (never fired here).
import { AWAITING_PAYMENT_CONFIRMATION } from '../../../shared/src/payments';
import { ORDER_STATUS_TRANSITIONS } from '../../../shared/src/order-status-transitions';
import {
  REFUND_EVENT_IDS_KEY,
  REFUND_STATUS_BY_ID_KEY,
  appendRefundEventId,
  correlateSettleNotice,
  executedClaimForRefundId,
  isRefundEventAlreadySeen,
  readAccountedRefundEventIds,
  recordRefundStatus,
  resolveRefundSettlement,
  selectInFlightClaims,
  selectOpenExecutedClaims,
} from '../../../shared/src/refunds/refund-settlement';
import { cancelOrder, refundOrder } from './refund';
import { approveSubmittedReceipts, ensureReceiptSchema } from './instapay-receipts';
import { MoneyError, type SyncSql } from './sync-sql';

export const REFUND_CLAIM_EVENT = 'refund_initiated';
export const REFUND_EXECUTED_EVENT = 'refund_completed';
export const REFUND_RELEASED_EVENT = 'refund_failed';
export const REFUND_INDETERMINATE_EVENT = 'refund_indeterminate';
export const REFUND_RECONCILED_EVENT = 'refund_reconciled';
/** A settle webhook reconciled with (and CONSUMED) a claim: `details = { claimId, refundId, amount }`. */
export const REFUND_ABSORBED_EVENT = 'refund_webhook_absorbed';
export const REFUND_REVIEW_EVENT = 'refund_reconcile_review';
const CLOSING_EVENTS = [
  REFUND_EXECUTED_EVENT,
  REFUND_RELEASED_EVENT,
  REFUND_INDETERMINATE_EVENT,
  REFUND_RECONCILED_EVENT,
  REFUND_ABSORBED_EVENT,
];
const AMOUNT_TOLERANCE_FILS = 5;
/** Providers whose delivery leaves a money-deciding field unsigned: confirmed server-to-server before anything is applied. */
export const CONFIRM_BEFORE_APPLY: ReadonlySet<string> = new Set(['kashier']);

export const PAYMENT_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS payment_event_log (
     provider TEXT NOT NULL, event_id TEXT NOT NULL, payment_id TEXT, outcome TEXT NOT NULL, applied_at INTEGER NOT NULL,
     PRIMARY KEY (provider, event_id)) WITHOUT ROWID`,
  // one refund claim, one of absorbed / released (the Postgres twin is payment_events_claim_single_outcome_key)
  `CREATE UNIQUE INDEX IF NOT EXISTS payment_events_claim_single_outcome_key ON payment_events (json_extract(details, '$.claimId'))
     WHERE event_type IN ('refund_webhook_absorbed', 'refund_failed')`,
];
export function ensurePaymentSchema(db: SyncSql): void {
  db.transactionSync(() => {
    for (const s of PAYMENT_STATEMENTS) db.run(s, []);
  });
}

const err = (code: string, message: string, status = 409, meta?: Record<string, unknown>) =>
  new MoneyError(code, message, status, meta);
const need = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || v.length < 1 || v.length > 200)
    throw err('BAD_ID', `${name} is required`, 400);
  return v;
};
const isInt = (n: unknown, min = 0): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= min;
const parse = (v: unknown): Record<string, unknown> => {
  try {
    const o = typeof v === 'string' ? JSON.parse(v) : v;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export interface PaymentRow {
  id: string;
  order_id: string;
  provider: string;
  status: string;
  amount: number;
  currency: string;
  refund_id: string | null;
  refunded_amount: number;
  metadata: string | null;
}
interface OrderRow {
  id: string;
  status: string;
  payment_status: string;
  total: number;
  wallet_amount: number;
  order_number: string;
  payment_confirmation_expires_at: number | null;
}
function loadPayment(db: SyncSql, storeId: string, paymentId: string): PaymentRow {
  const p = db.all(
    `SELECT p.id, p.order_id, p.provider, p.status, p.amount, p.currency, p.refund_id, p.refunded_amount, p.metadata
       FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = ? AND o.store_id = ?`,
    [paymentId, storeId]
  )[0];
  if (!p) throw err('PAYMENT_NOT_FOUND', 'payment not found', 404);
  return p as unknown as PaymentRow;
}
function loadOrder(db: SyncSql, storeId: string, orderId: string): OrderRow {
  const o = db.all(
    'SELECT id, status, payment_status, total, wallet_amount, order_number, payment_confirmation_expires_at FROM orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL',
    [orderId, storeId]
  )[0];
  if (!o) throw err('ORDER_NOT_FOUND', 'order not found', 404);
  return o as unknown as OrderRow;
}
export function addPaymentEvent(
  db: SyncSql,
  a: {
    storeId: string;
    paymentId: string;
    orderId: string;
    eventType: string;
    from?: string | null;
    to?: string | null;
    provider?: string | null;
    payload?: unknown;
    details?: Record<string, unknown>;
    userId?: string | null;
    now: number;
  }
): void {
  db.run(
    `INSERT INTO payment_events (id, payment_id, store_id, order_id, event_type, from_status, to_status, provider, provider_payload, details, triggered_by_user_id, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      a.paymentId,
      a.storeId,
      a.orderId,
      a.eventType,
      a.from ?? null,
      a.to ?? null,
      a.provider ?? null,
      a.payload === undefined ? null : JSON.stringify(a.payload),
      JSON.stringify(a.details ?? {}),
      a.userId ?? null,
      a.now,
      a.now,
    ]
  );
}
export function addOrderEvent(
  db: SyncSql,
  storeId: string,
  orderId: string,
  from: string | null,
  to: string,
  meta: Record<string, unknown>,
  now: number,
  actor: string | null = null
): void {
  db.run(
    'INSERT INTO order_events (id, store_id, order_id, from_status, to_status, actor_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [crypto.randomUUID(), storeId, orderId, from, to, actor, JSON.stringify(meta), now]
  );
}
/** Entity index (task 3.5): queue the id -> store row for D1 in the SAME section as the entity (drained by `drainEntityIndexOutbox`). */
export function indexEntity(
  db: SyncSql,
  storeId: string,
  kind: 'order' | 'payment' | 'refund' | 'webhook',
  id: string,
  now: number
): void {
  db.run(
    "INSERT INTO d1_outbox (kind, payload, next_attempt_at, created_at) VALUES ('entity_index', ?, ?, ?)",
    [JSON.stringify({ kind, id, storeId }), now, now]
  );
}
const assertTransition = (from: string, to: string): void => {
  if (from === to) return;
  if (!ORDER_STATUS_TRANSITIONS[from]?.includes(to))
    throw err('INVALID_STATUS_TRANSITION', `Cannot transition from ${from} to ${to}`, 400);
};

export interface Alert {
  kind: string;
  paymentId: string;
  orderId: string;
  body: string;
  context?: Record<string, unknown>;
}

// ---- payment rows --------------------------------------------------------------------------------------------------

/** The JSON a caller may store on a payment row: a plain object, bounded (it is shown back, never interpreted). */
function paymentMetadata(v: unknown): string {
  if (v === undefined || v === null) return '{}';
  if (typeof v !== 'object' || Array.isArray(v))
    throw err('PAYMENT_METADATA_INVALID', 'metadata must be an object', 400);
  const json = JSON.stringify(v);
  if (json.length > 4096) throw err('PAYMENT_METADATA_INVALID', 'metadata is too large', 400);
  return json;
}

/**
 * The payment row of an order (PaymentService.recordCreatedPayment, and the COD branch of POST /payments/create). The amount
 * is the amount DUE: the order total less the customer-wallet part paid at checkout (the Postgres callers all charge
 * `order.total - order.walletAmount`). A COD payment is created at most once while one is open: an open (`cod_pending` /
 * `completed`...) COD row of the order is returned instead, in the same section, so a double-click cannot mint two.
 */
export function createPayment(
  db: SyncSql,
  a: {
    storeId: string;
    orderId: string;
    provider: string;
    method?: string | null;
    amount: number;
    currency?: string;
    transactionId?: string | null;
    invoiceId?: string | null;
    paymentUrl?: string | null;
    metadata?: unknown;
    paymentId?: string;
    now?: number;
  }
): { paymentId: string; replayed?: boolean } {
  need(a.storeId, 'storeId');
  need(a.orderId, 'orderId');
  need(a.provider, 'provider');
  const now = a.now ?? Date.now();
  const metadata = paymentMetadata(a.metadata);
  return db.transactionSync(() => {
    const o = loadOrder(db, a.storeId, a.orderId);
    const due = o.total - (o.wallet_amount ?? 0);
    if (!isInt(a.amount, 1) || a.amount !== due)
      throw err(
        'PAYMENT_AMOUNT_MISMATCH',
        'payment amount must equal the amount due on the order',
        409,
        {
          total: o.total,
          due,
        }
      );
    if (a.provider === 'cod') {
      const open = db.all(
        "SELECT id FROM payments WHERE order_id = ? AND provider = 'cod' AND status NOT IN ('failed', 'cancelled', 'expired') ORDER BY created_at DESC LIMIT 1",
        [o.id]
      )[0];
      if (open) return { paymentId: open.id as string, replayed: true };
    }
    const id = a.paymentId ?? crypto.randomUUID();
    const status = a.provider === 'cod' ? 'cod_pending' : 'pending';
    db.run(
      `INSERT INTO payments (id, order_id, provider, method, status, amount, currency, transaction_id, invoice_id, payment_url, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        o.id,
        a.provider,
        a.method ?? null,
        status,
        a.amount,
        a.currency ?? 'EGP',
        a.transactionId ?? null,
        a.invoiceId ?? null,
        a.paymentUrl ?? null,
        metadata,
        now,
        now,
      ]
    );
    addPaymentEvent(db, {
      storeId: a.storeId,
      paymentId: id,
      orderId: o.id,
      eventType: 'created',
      to: status,
      provider: a.provider,
      now,
    });
    indexEntity(db, a.storeId, 'payment', id, now);
    for (const ref of [a.transactionId, a.invoiceId])
      if (ref) indexEntity(db, a.storeId, 'webhook', `${a.provider}:${ref}`, now);
    return { paymentId: id };
  });
}

/**
 * InstapayService.initiate on the DO (POST /payments/create, provider instapay): put a freshly created `pending`, unpaid
 * order on hold for a transfer and write its pending InstaPay payment, ONE section. A replay while the order is already
 * awaiting returns the SAME payment (`created: false`) and writes nothing. Same refusals as the Postgres path.
 */
export function initiateInstapay(
  db: SyncSql,
  a: {
    storeId: string;
    orderId: string;
    expiresAt: number;
    providerRef: string | null;
    metadata: unknown;
    actorUserId: string | null;
    now?: number;
  }
): {
  created: boolean;
  paymentId: string;
  amountMinor: number;
  metadata: Record<string, unknown>;
  expiresAt: number;
} {
  need(a.storeId, 'storeId');
  need(a.orderId, 'orderId');
  if (!isInt(a.expiresAt, 1)) throw err('INVALID_ARGS', 'expiresAt is required', 400);
  const now = a.now ?? Date.now();
  const metadata = paymentMetadata(a.metadata);
  return db.transactionSync(() => {
    const o = loadOrder(db, a.storeId, a.orderId);
    if (o.status === AWAITING_PAYMENT_CONFIRMATION) {
      const existing = db.all(
        "SELECT id, amount, metadata FROM payments WHERE order_id = ? AND provider = 'instapay' AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
        [o.id]
      )[0];
      if (existing)
        return {
          created: false,
          paymentId: existing.id as string,
          amountMinor: existing.amount as number,
          metadata: parse(existing.metadata),
          expiresAt: o.payment_confirmation_expires_at ?? a.expiresAt,
        };
    }
    if (o.status !== 'pending' || o.payment_status !== 'unpaid')
      throw err('ORDER_NOT_PAYABLE', 'This order can no longer be paid by InstaPay');
    const amountMinor = o.total - (o.wallet_amount ?? 0);
    if (amountMinor <= 0) throw err('ORDER_ALREADY_PAID', 'Nothing is due on this order');
    const claimed = db.run(
      "UPDATE orders SET status = ?, payment_confirmation_expires_at = ?, updated_at = ? WHERE id = ? AND store_id = ? AND status = 'pending' AND payment_status = 'unpaid'",
      [AWAITING_PAYMENT_CONFIRMATION, a.expiresAt, now, o.id, a.storeId]
    );
    if (claimed.changes < 1)
      throw err('ORDER_NOT_PAYABLE', 'This order can no longer be paid by InstaPay');
    const id = crypto.randomUUID();
    db.run(
      `INSERT INTO payments (id, order_id, provider, method, status, amount, currency, transaction_id, metadata, created_at, updated_at)
       VALUES (?, ?, 'instapay', 'instapay', 'pending', ?, (SELECT currency FROM orders WHERE id = ?), ?, ?, ?, ?)`,
      [id, o.id, amountMinor, o.id, a.providerRef, metadata, now, now]
    );
    addOrderEvent(
      db,
      a.storeId,
      o.id,
      'pending',
      AWAITING_PAYMENT_CONFIRMATION,
      { via: 'instapay_initiate', expiresAt: new Date(a.expiresAt).toISOString() },
      now,
      a.actorUserId
    );
    addPaymentEvent(db, {
      storeId: a.storeId,
      paymentId: id,
      orderId: o.id,
      eventType: 'created',
      to: 'pending',
      provider: 'instapay',
      userId: a.actorUserId,
      details: { amount: amountMinor, expiresAt: new Date(a.expiresAt).toISOString() },
      now,
    });
    indexEntity(db, a.storeId, 'payment', id, now);
    return {
      created: true,
      paymentId: id,
      amountMinor,
      metadata: parse(metadata),
      expiresAt: a.expiresAt,
    };
  });
}

/** Find the payment a webhook is about: by payment id, else by the provider's transaction or invoice reference. */
export function findPaymentByRef(
  db: SyncSql,
  storeId: string,
  provider: string,
  ref: string
): PaymentRow | null {
  const p = db.all(
    `SELECT p.id, p.order_id, p.provider, p.status, p.amount, p.currency, p.refund_id, p.refunded_amount, p.metadata
       FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE o.store_id = ? AND p.provider = ? AND (p.transaction_id = ? OR p.invoice_id = ? OR p.id = ?)
      ORDER BY p.created_at DESC LIMIT 1`,
    [storeId, provider, ref, ref, ref]
  )[0];
  return (p as unknown as PaymentRow) ?? null;
}

// ---- in-band refund: claim BEFORE the provider call, outcome AFTER ---------------------------------------------------

export interface RefundClaim {
  claimId: string;
  paymentId: string;
  orderId: string;
  amount: number;
  isFullRefund: boolean;
  /** a full refund that is not item-level reverses the ORDER */
  flipsOrder: boolean;
  priorStatus: string;
  claimedStatus: 'refunded' | 'partially_refunded';
  refundKey: string | null;
}

/**
 * Step 1 (sync, committed before any provider call): claim `amount` of the payment's refundable balance. Refuses a
 * payment that is not refundable, an amount above the remaining balance, an order state the refund cannot reverse, and a
 * `refundKey` that already has an outstanding claim (a retry after a timeout must not pay twice).
 */
export function beginRefund(
  db: SyncSql,
  a: {
    storeId: string;
    paymentId: string;
    amount?: number;
    refundKey?: string;
    reason?: string;
    itemLevel?: boolean;
    claimId?: string;
    now?: number;
  }
): RefundClaim {
  need(a.storeId, 'storeId');
  need(a.paymentId, 'paymentId');
  const now = a.now ?? Date.now();
  return db.transactionSync(() => {
    const p = loadPayment(db, a.storeId, a.paymentId);
    if (p.status !== 'completed' && p.status !== 'partially_refunded')
      throw err(
        'INVALID_STATE',
        'Payment is not refundable or a refund is already in progress',
        400
      );
    const remaining = p.amount - p.refunded_amount;
    if (remaining <= 0)
      throw err('PAYMENT_FULLY_REFUNDED', 'Payment is already fully refunded', 400);
    if (a.amount !== undefined && (!isInt(a.amount, 1) || a.amount > remaining))
      throw err(
        'REFUND_EXCEEDS_REMAINING',
        'Refund amount exceeds the un-refunded balance of this payment.',
        400
      );
    const amount = a.amount ?? remaining;
    const isFull = amount >= remaining;
    const flipsOrder = isFull && !a.itemLevel;
    const o = loadOrder(db, a.storeId, p.order_id);
    if (flipsOrder) assertTransition(o.status, 'refunded');
    const claimId = a.claimId ?? crypto.randomUUID();
    if (a.refundKey) {
      const released = releasedClaims(db, p.id);
      const open = db
        .all(
          `SELECT json_extract(details, '$.claimId') AS cid FROM payment_events WHERE payment_id = ? AND event_type = ? AND json_extract(details, '$.refundKey') = ?`,
          [p.id, REFUND_CLAIM_EVENT, a.refundKey]
        )
        .map(r => r.cid as string)
        .filter(cid => !released.has(cid));
      if (open.length > 0)
        throw err(
          'REFUND_ALREADY_ISSUED',
          'A refund for this was already sent to the payment provider and may have gone through. Check the provider dashboard before refunding again.',
          409,
          { refundKey: a.refundKey }
        );
    }
    const claimedStatus = isFull ? 'refunded' : 'partially_refunded';
    const cas = db.run(
      "UPDATE payments SET status = ?1, refunded_amount = ?2, updated_at = ?3 WHERE id = ?4 AND status IN ('completed', 'partially_refunded') AND refunded_amount = ?5",
      [claimedStatus, p.refunded_amount + amount, now, p.id, p.refunded_amount]
    );
    if (cas.changes < 1)
      throw err(
        'INVALID_STATE',
        'Payment is not refundable or a refund is already in progress',
        400
      );
    addPaymentEvent(db, {
      storeId: a.storeId,
      paymentId: p.id,
      orderId: p.order_id,
      eventType: REFUND_CLAIM_EVENT,
      from: p.status,
      to: claimedStatus,
      provider: p.provider,
      details: {
        claimId,
        amount,
        refundKey: a.refundKey ?? null,
        reason: a.reason ?? null,
        flipsOrder,
        isFullRefund: isFull,
        priorStatus: p.status,
      },
      now,
    });
    return {
      claimId,
      paymentId: p.id,
      orderId: p.order_id,
      amount,
      isFullRefund: isFull,
      flipsOrder,
      priorStatus: p.status,
      claimedStatus,
      refundKey: a.refundKey ?? null,
    };
  });
}
/** Claim ids that have a RELEASED event (the provider refused: nothing went out). */
function releasedClaims(db: SyncSql, paymentId: string): Set<string> {
  return new Set(
    db
      .all(
        `SELECT json_extract(details, '$.claimId') AS cid FROM payment_events WHERE payment_id = ? AND event_type = ?`,
        [paymentId, REFUND_RELEASED_EVENT]
      )
      .map(r => r.cid as string)
  );
}

/**
 * Step 3a (sync): the provider answered. Record its id and the `refund_completed` event in ONE section and, for a refund
 * that reverses the order, flip the order. A partial refund no item-level flow books is booked here for exactly this
 * amount, keyed on the provider's refund id (so its later settle webhook books nothing more).
 */
export function completeRefund(
  db: SyncSql,
  a: {
    storeId: string;
    claimId: string;
    refundId: string;
    providerStatus?: string;
    reason?: string;
    now?: number;
  }
): { orderStatus: string; booked: boolean; review: boolean } {
  need(a.refundId, 'refundId');
  const now = a.now ?? Date.now();
  return db.transactionSync(() => {
    const claim = findClaim(db, a.storeId, a.claimId);
    const p = loadPayment(db, a.storeId, claim.paymentId);
    const done = db.all(
      "SELECT 1 AS x FROM payment_events WHERE payment_id = ? AND event_type = ? AND json_extract(details, '$.claimId') = ?",
      [p.id, REFUND_EXECUTED_EVENT, a.claimId]
    )[0];
    if (done)
      return {
        orderStatus: loadOrder(db, a.storeId, p.order_id).status,
        booked: false,
        review: false,
      }; // replay
    // a settle webhook already ABSORBED this claim under a different refund id than the provider just answered with: two
    // refunds may have been reconciled as one. Nothing is overwritten; a human reviews it.
    const absorbedAs = db.all(
      "SELECT json_extract(details, '$.refundId') AS rid FROM payment_events WHERE payment_id = ? AND event_type = ? AND json_extract(details, '$.claimId') = ?",
      [p.id, REFUND_ABSORBED_EVENT, a.claimId]
    )[0]?.rid as string | undefined;
    // the answered id was already FILED under another claim (a webhook with this id was absorbed by a same-amount sibling):
    // close this claim on that evidence so it cannot hold later Kashier refunds forever
    if (!absorbedAs && readAccountedRefundEventIds(parse(p.metadata)).includes(a.refundId))
      addPaymentEvent(db, {
        storeId: a.storeId,
        paymentId: p.id,
        orderId: p.order_id,
        eventType: REFUND_ABSORBED_EVENT,
        provider: p.provider,
        details: { claimId: a.claimId, refundId: a.refundId, via: 'id_match_reassigned' },
        now,
      });
    const review = !!absorbedAs && absorbedAs !== a.refundId;
    if (review)
      addPaymentEvent(db, {
        storeId: a.storeId,
        paymentId: p.id,
        orderId: p.order_id,
        eventType: REFUND_REVIEW_EVENT,
        provider: p.provider,
        details: {
          claimId: a.claimId,
          reason: 'absorbed_under_a_different_refund_id',
          absorbedRefundId: absorbedAs,
          answeredRefundId: a.refundId,
        },
        now,
      });
    const meta = parse(p.metadata);
    const status = a.providerStatus ?? 'completed';
    const next = {
      ...meta,
      refundId: a.refundId,
      [REFUND_EVENT_IDS_KEY]: appendRefundEventId(meta, a.refundId),
      [REFUND_STATUS_BY_ID_KEY]: recordRefundStatus(meta, a.refundId, status),
      refundStatus: status,
      refundReason: a.reason ?? claim.reason ?? null,
      refundedAt: new Date(now).toISOString(),
    };
    db.run('UPDATE payments SET refund_id = ?, metadata = ?, updated_at = ? WHERE id = ?', [
      a.refundId,
      JSON.stringify(next),
      now,
      p.id,
    ]);
    if (claim.flipsOrder) {
      const o = loadOrder(db, a.storeId, p.order_id);
      assertTransition(o.status, 'refunded');
      db.run(
        "UPDATE orders SET status = 'refunded', payment_status = 'refunded', updated_at = ? WHERE id = ? AND store_id = ?",
        [now, o.id, a.storeId]
      );
      addOrderEvent(
        db,
        a.storeId,
        o.id,
        o.status,
        'refunded',
        { via: 'provider_refund', refundId: a.refundId },
        now
      );
      // The whole-order reversal (stock, coupon, loyalty, wallet, backorders) is part of THIS section (Opus I4, Ruling
      // CF-OPUS-4): the provider's refund is an external fact, so a failure here rolls back the executed marker too and the
      // caller's retry of `refundComplete` re-runs both, instead of leaving a refunded payment with an unreversed order.
      refundOrder(db, { storeId: a.storeId, orderId: o.id, external: true, now });
    }
    addPaymentEvent(db, {
      storeId: a.storeId,
      paymentId: p.id,
      orderId: p.order_id,
      eventType: REFUND_EXECUTED_EVENT,
      to: claim.claimedStatus,
      provider: p.provider,
      details: { claimId: a.claimId, refundId: a.refundId, providerStatus: status },
      now,
    });
    indexEntity(db, a.storeId, 'refund', `${p.provider}:${a.refundId}`, now);
    let booked = false;
    if (!claim.flipsOrder && !claim.refundKey) {
      refundOrder(db, {
        storeId: a.storeId,
        orderId: p.order_id,
        amount: claim.amount,
        refundKey: a.refundId,
        external: true,
        now,
      });
      booked = true;
    }
    return { orderStatus: loadOrder(db, a.storeId, p.order_id).status, booked, review };
  });
}

interface ClaimInfo {
  paymentId: string;
  amount: number;
  flipsOrder: boolean;
  claimedStatus: string;
  refundKey: string | null;
  reason: string | null;
}
function findClaim(db: SyncSql, storeId: string, claimId: string): ClaimInfo {
  const r = db.all(
    `SELECT payment_id, details FROM payment_events WHERE store_id = ? AND event_type = ? AND json_extract(details, '$.claimId') = ?`,
    [storeId, REFUND_CLAIM_EVENT, claimId]
  )[0];
  if (!r) throw err('CLAIM_NOT_FOUND', 'refund claim not found', 404);
  const d = parse(r.details);
  return {
    paymentId: r.payment_id as string,
    amount: d.amount as number,
    flipsOrder: d.flipsOrder === true,
    claimedStatus: (d.isFullRefund ? 'refunded' : 'partially_refunded') as string,
    refundKey: (d.refundKey as string | null) ?? null,
    reason: (d.reason as string | null) ?? null,
  };
}

/**
 * Step 3b (sync): the provider REFUSED (nothing was sent): give the claimed amount back. A claim that a settle webhook
 * already absorbed is NOT released (the gateway says money left): it is marked for review instead.
 */
export function releaseRefund(
  db: SyncSql,
  a: { storeId: string; claimId: string; reason: string; error?: string; now?: number }
): { released: boolean; review: boolean } {
  const now = a.now ?? Date.now();
  return db.transactionSync(() => {
    const claim = findClaim(db, a.storeId, a.claimId);
    const p = loadPayment(db, a.storeId, claim.paymentId);
    const absorbed = db.all(
      "SELECT 1 AS x FROM payment_events WHERE payment_id = ? AND event_type = ? AND json_extract(details, '$.claimId') = ?",
      [p.id, REFUND_ABSORBED_EVENT, a.claimId]
    )[0];
    if (absorbed) {
      addPaymentEvent(db, {
        storeId: a.storeId,
        paymentId: p.id,
        orderId: p.order_id,
        eventType: REFUND_REVIEW_EVENT,
        provider: p.provider,
        details: {
          claimId: a.claimId,
          reason: 'claim_released_after_webhook_reported_it_completed',
          error: a.error ?? null,
        },
        now,
      });
      return { released: false, review: true };
    }
    if (releasedClaims(db, p.id).has(a.claimId)) return { released: false, review: false }; // replay
    if (p.refunded_amount < claim.amount)
      throw err('CLAIM_NOT_ON_PAYMENT', 'refund claim no longer on the payment row', 409);
    const left = p.refunded_amount - claim.amount;
    const status =
      left <= 0
        ? (claimPrior(db, p.id, a.claimId) ?? p.status)
        : left >= p.amount
          ? 'refunded'
          : 'partially_refunded';
    db.run('UPDATE payments SET refunded_amount = ?, status = ?, updated_at = ? WHERE id = ?', [
      left,
      status,
      now,
      p.id,
    ]);
    addPaymentEvent(db, {
      storeId: a.storeId,
      paymentId: p.id,
      orderId: p.order_id,
      eventType: REFUND_RELEASED_EVENT,
      from: claim.claimedStatus,
      to: status,
      provider: p.provider,
      details: { claimId: a.claimId, reason: a.reason, error: a.error ?? null },
      now,
    });
    return { released: true, review: false };
  });
}
const claimPrior = (db: SyncSql, paymentId: string, claimId: string): string | null =>
  (db.all(
    "SELECT json_extract(details, '$.priorStatus') AS s FROM payment_events WHERE payment_id = ? AND event_type = ? AND json_extract(details, '$.claimId') = ?",
    [paymentId, REFUND_CLAIM_EVENT, claimId]
  )[0]?.s as string | undefined) ?? null;

/** Step 3c (sync): the provider gave no clear answer (timeout / 5xx): the claim STANDS (it may have gone out) and is flagged. */
export function markRefundIndeterminate(
  db: SyncSql,
  a: { storeId: string; claimId: string; error: string; now?: number }
): void {
  const now = a.now ?? Date.now();
  db.transactionSync(() => {
    const claim = findClaim(db, a.storeId, a.claimId);
    const p = loadPayment(db, a.storeId, claim.paymentId);
    addPaymentEvent(db, {
      storeId: a.storeId,
      paymentId: p.id,
      orderId: p.order_id,
      eventType: REFUND_INDETERMINATE_EVENT,
      provider: p.provider,
      details: { claimId: a.claimId, error: a.error },
      now,
    });
  });
}

// ---- webhooks --------------------------------------------------------------------------------------------------------

export type WebhookPaymentStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelled'
  | 'refunded';
export interface PaymentWebhookInput {
  storeId: string;
  provider: string;
  /** the provider's SIGNED event identity: the idempotency key */
  eventId: string;
  /** transaction / invoice / merchant reference the payment was created with, or the payment id */
  providerRef: string;
  kind: 'payment' | 'refund';
  event?: string;
  status?: WebhookPaymentStatus;
  amount?: number | null;
  currency?: string | null;
  paidAt?: number | null;
  paymentMethod?: string | null;
  refund?: {
    refundId: string;
    status: 'completed' | 'failed' | 'pending' | 'processing';
    amount?: number | null;
    refundReference?: string | null;
  };
  rawPayload?: unknown;
  now?: number;
}
/** The gateway's own record of the transaction (confirm-before-apply). */
export interface ConfirmedTransaction {
  kind: 'payment' | 'authorize' | 'refund';
  status: 'SUCCESS' | 'FAILURE' | 'PENDING';
  operation?: string;
}
export interface ApplyDeps {
  /** server-to-server confirmation; MUST throw when the gateway does not answer clearly (nothing is applied then) */
  confirm?: (input: PaymentWebhookInput) => Promise<ConfirmedTransaction>;
}
export interface ApplyResult {
  outcome: 'applied' | 'replayed' | 'ignored' | 'held';
  paymentId: string;
  orderId: string;
  paymentStatus: string;
  orderStatus: string;
  alerts: Alert[];
  /** for the Worker, after the commit: 'order_paid' (fan-out), 'payment_failed' */
  postCommit: Array<'order_paid' | 'payment_failed' | 'order_reversed'>;
}

const foldStatus = (s: ConfirmedTransaction['status']): WebhookPaymentStatus =>
  s === 'SUCCESS' ? 'completed' : s === 'FAILURE' ? 'failed' : 'pending';

export async function applyPaymentEvent(
  db: SyncSql,
  input: PaymentWebhookInput,
  deps: ApplyDeps = {}
): Promise<ApplyResult> {
  need(input.storeId, 'storeId');
  need(input.provider, 'provider');
  need(input.eventId, 'eventId');
  need(input.providerRef, 'providerRef');
  // 1. cheap replay check and payment lookup (sync, no writes)
  const pre = db.all(
    'SELECT payment_id, outcome FROM payment_event_log WHERE provider = ? AND event_id = ?',
    [input.provider, input.eventId]
  )[0];
  const payment = findPaymentByRef(db, input.storeId, input.provider, input.providerRef);
  if (!payment) throw err('PAYMENT_NOT_FOUND', 'no payment for this reference in this store', 404);
  if (pre) return replayResult(db, input.storeId, payment);

  // 2. confirm-before-apply: external I/O OUTSIDE the section; fail closed
  let confirmed: ConfirmedTransaction | null = null;
  if (CONFIRM_BEFORE_APPLY.has(input.provider)) {
    if (!deps.confirm)
      throw err(
        'WEBHOOK_UNCONFIRMED',
        'this provider must be confirmed with the gateway before anything is applied',
        503
      );
    try {
      confirmed = await deps.confirm(input);
    } catch (e) {
      throw err(
        'WEBHOOK_UNCONFIRMED',
        `The gateway could not confirm this webhook; it was not applied and will be retried (${(e instanceof Error ? e.message : String(e)).slice(0, 200)})`,
        503
      );
    }
  }

  // 3. apply: ONE section
  return applyPaymentEventSync(db, input, confirmed);
}

/**
 * The apply half of `applyPaymentEvent`, synchronous: replay check, ONE section, no I/O. The `moneyOp` registry calls this
 * directly (the Worker does the gateway confirmation OUTSIDE the Durable Object and hands the answer in), so a provider in
 * CONFIRM_BEFORE_APPLY with no `confirmed` is refused (503, nothing written): fail closed, like the async wrapper.
 */
export function applyPaymentEventSync(
  db: SyncSql,
  input: PaymentWebhookInput,
  confirmed: ConfirmedTransaction | null
): ApplyResult {
  need(input.storeId, 'storeId');
  need(input.provider, 'provider');
  need(input.eventId, 'eventId');
  need(input.providerRef, 'providerRef');
  const payment = findPaymentByRef(db, input.storeId, input.provider, input.providerRef);
  if (!payment) throw err('PAYMENT_NOT_FOUND', 'no payment for this reference in this store', 404);
  if (CONFIRM_BEFORE_APPLY.has(input.provider) && !confirmed) {
    const seenAlready = db.all(
      'SELECT 1 AS x FROM payment_event_log WHERE provider = ? AND event_id = ?',
      [input.provider, input.eventId]
    )[0];
    if (seenAlready) return replayResult(db, input.storeId, payment);
    throw err(
      'WEBHOOK_UNCONFIRMED',
      'this provider must be confirmed with the gateway before anything is applied',
      503
    );
  }
  const now = input.now ?? Date.now();
  return db.transactionSync(() => {
    const seen = db.all(
      'SELECT 1 AS x FROM payment_event_log WHERE provider = ? AND event_id = ?',
      [input.provider, input.eventId]
    )[0];
    const p = loadPayment(db, input.storeId, payment.id);
    if (seen) return replayResult(db, input.storeId, p);
    const o = loadOrder(db, input.storeId, p.order_id);
    const alerts: Alert[] = [];
    const postCommit: ApplyResult['postCommit'] = [];
    const finish = (outcome: ApplyResult['outcome'], note: string): ApplyResult => {
      db.run(
        'INSERT INTO payment_event_log (provider, event_id, payment_id, outcome, applied_at) VALUES (?, ?, ?, ?, ?)',
        [input.provider, input.eventId, p.id, `${outcome}:${note}`.slice(0, 200), now]
      );
      const pp = loadPayment(db, input.storeId, p.id);
      return {
        outcome,
        paymentId: p.id,
        orderId: p.order_id,
        paymentStatus: pp.status,
        orderStatus: loadOrder(db, input.storeId, p.order_id).status,
        alerts,
        postCommit,
      };
    };
    let kind = input.kind;
    let status = input.status;
    let refundOverride: PaymentWebhookInput['refund'] | undefined;
    if (confirmed) {
      const confirmedKind = confirmed.kind === 'authorize' ? 'authorize' : confirmed.kind;
      const foldRefund = (c: ConfirmedTransaction['status']) =>
        c === 'SUCCESS' ? 'completed' : c === 'FAILURE' ? 'failed' : 'pending';
      const mismatch =
        confirmedKind !== input.kind ||
        (input.kind === 'payment' && foldStatus(confirmed.status) !== input.status) ||
        (input.kind === 'refund' && foldRefund(confirmed.status) !== input.refund?.status);
      addPaymentEvent(db, {
        storeId: input.storeId,
        paymentId: p.id,
        orderId: p.order_id,
        eventType: mismatch ? 'webhook_corrected' : 'webhook_confirmed',
        from: p.status,
        provider: input.provider,
        details: {
          claimed: { kind: input.kind, status: input.status ?? input.refund?.status },
          confirmed,
          source: 'gateway',
        },
        now,
      });
      if (confirmedKind === 'authorize') return finish('ignored', 'authorized only');
      if (confirmedKind !== input.kind) {
        // the delivery was relabelled (payment <-> refund): the gateway record has no amount/id for the other kind, so
        // NOTHING is applied; a human looks (fail closed)
        alerts.push({
          kind: 'webhook_kind_mismatch',
          paymentId: p.id,
          orderId: p.order_id,
          body: `Order ${o.order_number}: ${input.provider} delivered a ${input.kind} but the gateway record says ${confirmedKind}. Nothing applied.`,
        });
        return finish('held', 'kind mismatch');
      }
      if (kind === 'payment') status = foldStatus(confirmed.status);
      // the GATEWAY's refund status is what is applied, not the delivery's label
      if (kind === 'refund' && input.refund)
        refundOverride = { ...input.refund, status: foldRefund(confirmed.status) };
    }
    if (kind === 'refund')
      return applyRefundWebhook({
        db,
        input: refundOverride ? { ...input, refund: refundOverride } : input,
        p,
        o,
        now,
        alerts,
        postCommit,
        finish,
        confirmedRefund: confirmed?.kind === 'refund',
      });
    return applyPaymentWebhook({
      db,
      input,
      p,
      o,
      now,
      alerts,
      postCommit,
      finish,
      status: status ?? 'pending',
    });
  });
}

function replayResult(db: SyncSql, storeId: string, p: PaymentRow): ApplyResult {
  const pp = loadPayment(db, storeId, p.id);
  return {
    outcome: 'replayed',
    paymentId: p.id,
    orderId: p.order_id,
    paymentStatus: pp.status,
    orderStatus: loadOrder(db, storeId, p.order_id).status,
    alerts: [],
    postCommit: [],
  };
}

interface Ctx {
  db: SyncSql;
  input: PaymentWebhookInput;
  p: PaymentRow;
  o: OrderRow;
  now: number;
  alerts: Alert[];
  postCommit: ApplyResult['postCommit'];
  finish: (outcome: ApplyResult['outcome'], note: string) => ApplyResult;
}

const LIVE_PAYMENT = new Set(['completed', 'refunded', 'partially_refunded', 'disputed']);

function applyPaymentWebhook(c: Ctx & { status: WebhookPaymentStatus }): ApplyResult {
  const { db, input, p, o, now, alerts, postCommit, finish, status } = c;
  const meta = parse(p.metadata);
  // Money already captured is never downgraded by a stale or contradictory notice: record it, keep the state, alert.
  // (a replayed `completed` over a refunded / partially refunded / disputed payment is the same downgrade)
  const FINANCIAL_AFTER_CAPTURE = new Set(['refunded', 'partially_refunded', 'disputed']);
  if (
    (LIVE_PAYMENT.has(p.status) && status !== 'completed' && status !== 'refunded') ||
    (status === 'completed' && FINANCIAL_AFTER_CAPTURE.has(p.status))
  ) {
    addPaymentEvent(db, {
      storeId: input.storeId,
      paymentId: p.id,
      orderId: p.order_id,
      eventType: 'webhook',
      from: p.status,
      provider: input.provider,
      payload: input.rawPayload,
      details: {
        ignored: 'would_downgrade_captured_payment',
        webhookStatus: status,
        webhookEvent: input.event ?? null,
      },
      now,
    });
    alerts.push({
      kind: 'payment_downgrade_ignored',
      paymentId: p.id,
      orderId: p.order_id,
      body: `Order ${o.order_number}: ${input.provider} reported ${status} for a payment already ${p.status}; state kept. Check the provider dashboard.`,
    });
    return finish('ignored', 'no downgrade');
  }
  // Paid-amount reconciliation (money-integrity F3, review I-4 of PR 455): a `completed` delivery confirms the order ONLY when
  // it states the amount due (within the tolerance) in the payment's currency. Short, over, a missing amount or another
  // currency is an external money fact: recorded in full on the payment (never rejected, never lost), the order NOT marked
  // paid, a P1 raised for a human.
  const amountGiven = typeof input.amount === 'number' && Number.isFinite(input.amount);
  const mismatch: null | 'paid_amount_missing' | 'paid_currency_mismatch' | 'paid_amount_mismatch' =
    status !== 'completed'
      ? null
      : !amountGiven
        ? 'paid_amount_missing'
        : input.currency !== p.currency
          ? 'paid_currency_mismatch'
          : Math.abs(p.amount - (input.amount as number)) > AMOUNT_TOLERANCE_FILS
            ? 'paid_amount_mismatch'
            : null;
  if (mismatch) {
    addPaymentEvent(db, {
      storeId: input.storeId,
      paymentId: p.id,
      orderId: p.order_id,
      eventType: 'reconciliation',
      from: p.status,
      provider: input.provider,
      payload: input.rawPayload,
      details: {
        reason: mismatch,
        expectedFils: p.amount,
        expectedCurrency: p.currency,
        paidAmountFils: amountGiven ? input.amount : null,
        paidCurrency: input.currency ?? null,
        webhookEvent: input.event ?? null,
      },
      now,
    });
    db.run('UPDATE payments SET metadata = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify({
        ...meta,
        webhookEvent: input.event ?? null,
        paymentMethod: input.paymentMethod ?? null,
        paidCurrency: input.currency ?? null,
        paidAmount: amountGiven ? input.amount : null,
        amountMismatch: true,
        mismatchReason: mismatch,
      }),
      now,
      p.id,
    ]);
    alerts.push({
      kind: 'amount_mismatch',
      paymentId: p.id,
      orderId: p.order_id,
      body: `Order ${o.order_number}: ${input.provider} webhook reports paid ${amountGiven ? input.amount : 'no amount'} ${input.currency ?? '(no currency)'} but the amount due is ${p.amount} ${p.currency} (${mismatch}). NOT marked paid.`,
      context: {
        expected: p.amount,
        expectedCurrency: p.currency,
        paid: amountGiven ? input.amount : null,
        paidCurrency: input.currency ?? null,
        reason: mismatch,
      },
    });
    return finish('held', mismatch);
  }
  let orderStatus: 'pending' | 'confirmed' = 'pending';
  let orderPay: 'unpaid' | 'paid' | 'failed' | 'refunded' = 'unpaid';
  if (status === 'completed') {
    orderStatus = 'confirmed';
    orderPay = 'paid';
  } else if (status === 'failed' || status === 'expired' || status === 'cancelled')
    orderPay = 'failed';
  else if (status === 'refunded') orderPay = 'refunded';
  // assert the ORDER transition BEFORE any write (a throw rolls the whole section back, nothing is half-applied)
  // an order the merchant already moved on (processing / shipped / delivered) is marked PAID without moving its
  // fulfilment status (P08-2 c), so a capture is never refused for ever; cancelled / refunded still throw
  const fulfilled = ['processing', 'shipped', 'delivered'].includes(o.status);
  // (a failure never sets the order status, so only the confirming and refunding statuses assert a transition)
  // A gateway capture/refund is an EXTERNAL money fact (MONEY-FACT-1, Ruling CF-OPUS-3): when the order cannot take the
  // transition (cancelled / expired hold, already refunded) the payment is still recorded in full, the order status is kept,
  // the order is flagged for review and an alert is raised. Never a throw: that would roll the whole section back and lose it.
  let blockedTransition = false;
  if (
    ((status === 'completed' && !fulfilled) || status === 'refunded') &&
    o.status !== orderStatus &&
    !ORDER_STATUS_TRANSITIONS[o.status]?.includes(orderStatus)
  )
    blockedTransition = true;
  // the order was already settled by another path (pull-side confirm, an earlier event): no second fan-out
  const orderWasPaid = o.payment_status === 'paid';
  db.run('UPDATE payments SET status = ?, paid_at = ?, metadata = ?, updated_at = ? WHERE id = ?', [
    status,
    input.paidAt ?? (status === 'completed' ? now : null),
    JSON.stringify({
      ...meta,
      webhookEvent: input.event ?? null,
      paymentMethod: input.paymentMethod ?? null,
      paidCurrency: input.currency ?? null,
      paidAmount: input.amount ?? null,
    }),
    now,
    p.id,
  ]);
  if (status === 'completed') {
    const dup = db.all(
      "SELECT count(*) AS n FROM payments WHERE order_id = ? AND status = 'completed' AND id <> ?",
      [p.order_id, p.id]
    )[0].n as number;
    if (dup > 0)
      alerts.push({
        kind: 'duplicate_capture',
        paymentId: p.id,
        orderId: p.order_id,
        body: `Order ${o.order_number}: a second payment was captured for this order (customer paid twice).`,
      });
  }
  addPaymentEvent(db, {
    storeId: input.storeId,
    paymentId: p.id,
    orderId: p.order_id,
    eventType: 'webhook',
    from: p.status,
    to: status,
    provider: input.provider,
    payload: input.rawPayload,
    details: {
      webhookEvent: input.event ?? null,
      paymentMethod: input.paymentMethod ?? null,
      paidCurrency: input.currency ?? null,
      paidAmount: input.amount ?? null,
    },
    now,
  });
  // a failure only ever moves an UNPAID order (a paid / refunded one keeps its state, P08-2 a)
  const failureOnSettledOrder = orderPay === 'failed' && o.payment_status !== 'unpaid';
  if (blockedTransition) {
    addOrderEvent(
      db,
      input.storeId,
      o.id,
      o.status,
      o.status,
      {
        via: 'payment_webhook',
        provider: input.provider,
        review:
          status === 'completed'
            ? 'captured_on_unconfirmable_order'
            : 'refund_on_unreversible_order',
        paymentId: p.id,
        paymentStatus: status,
      },
      now
    );
    alerts.push({
      kind:
        status === 'completed' ? 'captured_on_unconfirmable_order' : 'refund_on_unreversible_order',
      paymentId: p.id,
      orderId: p.order_id,
      body:
        status === 'completed'
          ? `Order ${o.order_number}: ${input.provider} CAPTURED the payment but the order is ${o.status}. The capture is recorded and the order flagged for review; refund the customer or restore the order.`
          : `Order ${o.order_number}: ${input.provider} reports a refund but the order is ${o.status}, which cannot move to refunded. Recorded on the payment; reverse the order by hand.`,
      context: { orderStatus: o.status, paymentStatus: status },
    });
  }
  if (status !== 'pending' && status !== 'processing' && !failureOnSettledOrder) {
    db.run(
      'UPDATE orders SET status = ?, payment_status = ?, updated_at = ? WHERE id = ? AND store_id = ?',
      [
        orderStatus === 'confirmed' && !fulfilled && !blockedTransition ? 'confirmed' : o.status,
        orderPay,
        now,
        o.id,
        input.storeId,
      ]
    );
    if (orderStatus === 'confirmed' && o.status !== 'confirmed' && !fulfilled && !blockedTransition)
      addOrderEvent(
        db,
        input.storeId,
        o.id,
        o.status,
        'confirmed',
        { via: 'payment_webhook', provider: input.provider },
        now
      );
  }
  if (status === 'completed' && !orderWasPaid && !blockedTransition) postCommit.push('order_paid');
  else if (
    (status === 'failed' || status === 'expired' || status === 'cancelled') &&
    !failureOnSettledOrder
  )
    postCommit.push('payment_failed');
  return finish('applied', status);
}

function applyRefundWebhook(c: Ctx & { confirmedRefund: boolean }): ApplyResult {
  const { db, input, p, o, now, alerts, postCommit, finish } = c;
  const r = input.refund;
  if (!r) throw err('BAD_WEBHOOK', 'a refund event carries a refund', 400);
  const events = db
    .all(
      'SELECT event_type, created_at, details FROM payment_events WHERE payment_id = ? AND event_type IN (' +
        [REFUND_CLAIM_EVENT, ...CLOSING_EVENTS].map(() => '?').join(', ') +
        ')',
      [p.id, REFUND_CLAIM_EVENT, ...CLOSING_EVENTS]
    )
    .map(e => ({
      eventType: e.event_type as string,
      createdAt: e.created_at as number,
      details: parse(e.details),
    }));
  // Fawry's amount-less notice ref is not proven unique per refund: a repeat is never silently 'seen' and its id is never filed
  const fawryAmountless =
    input.provider === 'fawry' && !(typeof r.amount === 'number' && r.amount > 0);
  const consumeByOwnId = () => {
    const cid = executedClaimForRefundId({
      events,
      refundId: r.refundId,
      executedEvent: REFUND_EXECUTED_EVENT,
      closingEvents: [
        REFUND_RELEASED_EVENT,
        REFUND_INDETERMINATE_EVENT,
        REFUND_RECONCILED_EVENT,
        REFUND_ABSORBED_EVENT,
      ],
    });
    if (cid)
      addPaymentEvent(db, {
        storeId: input.storeId,
        paymentId: p.id,
        orderId: p.order_id,
        eventType: REFUND_ABSORBED_EVENT,
        provider: input.provider,
        details: { claimId: cid, refundId: r.refundId, via: 'id_match' },
        now,
      });
  };
  const meta = parse(p.metadata);
  const prevStatus = (meta.refundStatus as string | undefined) ?? 'pending';
  if (
    !fawryAmountless &&
    isRefundEventAlreadySeen({
      metadata: meta,
      refundId: r.refundId,
      status: r.status,
      previousPaymentStatus: prevStatus,
    })
  ) {
    if (r.status === 'completed') consumeByOwnId();
    return finish('ignored', 'refund event matches stored status');
  }

  const completed = r.status === 'completed';
  // only a COMPLETED refund can be reconciled with (and consume) a claim
  const inFlightClaims = completed
    ? selectInFlightClaims({
        events,
        now,
        claimEvent: REFUND_CLAIM_EVENT,
        closingEvents: CLOSING_EVENTS,
      })
    : [];
  const amountless = !(typeof r.amount === 'number' && r.amount > 0);
  // An amount-less Fawry notice is attributed to ONE executed claim of ours on positive evidence, else held + alerted.
  const correlatedClaimId =
    completed && amountless && input.provider === 'fawry'
      ? correlateSettleNotice({
          events,
          noticeRef: r.refundId,
          now,
          claimEvent: REFUND_CLAIM_EVENT,
          executedEvent: REFUND_EXECUTED_EVENT,
          closingEvents: [
            REFUND_RELEASED_EVENT,
            REFUND_INDETERMINATE_EVENT,
            REFUND_RECONCILED_EVENT,
            REFUND_ABSORBED_EVENT,
          ],
        })
      : null;
  const s0 = resolveRefundSettlement({
    paymentAmount: p.amount,
    alreadyRefunded: p.refunded_amount,
    reported: [r.amount],
    reportedEventId: r.refundId,
    accountedEventIds: readAccountedRefundEventIds(meta),
    inFlightClaims,
    correlatedClaimId,
    // Kashier: the refund API's id is not proven equal to the webhook's transactionId. With an own executed claim still
    // open, an unknown id is HELD (never auto-booked); an operator matches it (matchRefundToClaim).
    openExecutedClaimWithUnverifiedId:
      completed &&
      input.provider === 'kashier' &&
      selectOpenExecutedClaims({
        events,
        now,
        claimEvent: REFUND_CLAIM_EVENT,
        executedEvent: REFUND_EXECUTED_EVENT,
        closingEvents: [
          REFUND_RELEASED_EVENT,
          REFUND_INDETERMINATE_EVENT,
          REFUND_RECONCILED_EVENT,
          REFUND_ABSORBED_EVENT,
        ],
      }).length > 0,
  });
  // only a COMPLETED refund is accounted: a pending / failed notice must not file its id (that would make the real, later
  // completed refund look already counted and it would never be added)
  const s = completed ? s0 : { ...s0, accountedThisEvent: false };
  const orderAlreadyReversed = o.status === 'refunded';
  if (completed && !orderAlreadyReversed && s.isFullRefund) {
    // The gateway SAYS the money went back: that is an external fact, recorded and never rejected (CF-PAY-1). An order
    // state the machine would not leave for `refunded` does not stop the payment bookkeeping; it raises an alert.
    if (ORDER_STATUS_TRANSITIONS[o.status]?.includes('refunded') || o.status === 'refunded') {
      refundOrder(db, { storeId: input.storeId, orderId: o.id, now });
      postCommit.push('order_reversed');
    } else
      alerts.push({
        kind: 'refund_on_unreversible_order',
        paymentId: p.id,
        orderId: p.order_id,
        body: `Order ${o.order_number}: ${input.provider} reports a full refund but the order is ${o.status}, which cannot move to refunded. The refund is recorded on the payment; reverse the order by hand.`,
      });
  } else if (
    completed &&
    !orderAlreadyReversed &&
    s.accountedThisEvent &&
    s.settledTotal - p.refunded_amount > 0
  ) {
    // a partial out-of-band refund: booked once for exactly the accounted amount, keyed on the provider's refund id
    try {
      refundOrder(db, {
        storeId: input.storeId,
        orderId: o.id,
        amount: s.settledTotal - p.refunded_amount,
        refundKey: r.refundId,
        external: true,
        now,
      });
    } catch (e) {
      if (!(e instanceof MoneyError)) throw e;
      alerts.push({
        kind: 'partial_not_booked',
        paymentId: p.id,
        orderId: p.order_id,
        body: `Order ${o.order_number}: refund ${r.refundId} was accounted on the payment but could not be booked on the order (${e.code}). Book it by hand.`,
      });
    }
  }
  if (completed && !s.absorbedClaimId) consumeByOwnId();
  if (s.absorbedClaimId && completed) {
    // CONSUME the claim in this same section: no second webhook can match it
    addPaymentEvent(db, {
      storeId: input.storeId,
      paymentId: p.id,
      orderId: p.order_id,
      eventType: REFUND_ABSORBED_EVENT,
      provider: input.provider,
      details: { claimId: s.absorbedClaimId, refundId: r.refundId, amount: r.amount ?? null },
      now,
    });
  }
  const next = {
    ...meta,
    refundId: r.refundId,
    ...(s.accountedThisEvent || (completed && s.absorbedClaimId && !fawryAmountless)
      ? { [REFUND_EVENT_IDS_KEY]: appendRefundEventId(meta, r.refundId) }
      : {}),
    refundStatus: r.status,
    [REFUND_STATUS_BY_ID_KEY]: recordRefundStatus(meta, r.refundId, r.status),
    refundReference: r.refundReference ?? (meta.refundReference as string | undefined) ?? null,
    refundStatusUpdatedAt: new Date(now).toISOString(),
  };
  const raise = completed && p.status !== 'refunded';
  const newStatus = raise ? (s.isFullRefund ? 'refunded' : 'partially_refunded') : p.status;
  db.run(
    'UPDATE payments SET metadata = ?, status = ?, refunded_amount = ?, updated_at = ? WHERE id = ?',
    [JSON.stringify(next), newStatus, raise ? s.settledTotal : p.refunded_amount, now, p.id]
  );
  addPaymentEvent(db, {
    storeId: input.storeId,
    paymentId: p.id,
    orderId: p.order_id,
    eventType: 'webhook',
    from: p.status,
    to: raise ? (newStatus as string) : null,
    provider: input.provider,
    payload: input.rawPayload,
    details: {
      flavour: 'refund',
      refundId: r.refundId,
      refundStatus: r.status,
      reportedAmount: r.amount ?? null,
      absorbedClaimId: s.absorbedClaimId,
      ...(completed && s.heldOpenClaimIdUnverified
        ? { heldUnaccountedRefund: true, reason: 'open_claim_id_unverified' }
        : completed && s.heldUnaccountedEvent
          ? { heldUnaccountedRefund: true, reason: 'refund_amount_not_reported' }
          : completed && s.heldProvenanceUnknown
            ? { heldUnaccountedRefund: true, reason: 'refund_provenance_unknown' }
            : {}),
    },
    now,
  });
  indexEntity(db, input.storeId, 'refund', `${input.provider}:${r.refundId}`, now);
  if (completed && s.heldOpenClaimIdUnverified)
    alerts.push({
      kind: 'held_open_claim_id_unverified',
      paymentId: p.id,
      orderId: p.order_id,
      body: `Order ${o.order_number}: ${input.provider} reported refund ${r.refundId} (${r.amount ?? '?'} piastres) as completed with an id this system has not seen, while a refund sent from here is still open on the payment. NOT booked. Match it to the claim, or book it by hand.`,
    });
  else if (completed && s.heldUnaccountedEvent)
    alerts.push({
      kind: 'held_unaccounted',
      paymentId: p.id,
      orderId: p.order_id,
      body: `Order ${o.order_number}: the provider reported refund ${r.refundId} as completed without a usable amount, so the refunded total was NOT raised. Check the provider dashboard.`,
    });
  else if (completed && s.heldProvenanceUnknown)
    alerts.push({
      kind: 'held_provenance_unknown',
      paymentId: p.id,
      orderId: p.order_id,
      body: `Order ${o.order_number}: refund ${r.refundId} (${r.amount ?? '?'} piastres) was NOT added: this payment predates the per-refund ledger. Check the provider dashboard.`,
    });
  return finish('applied', `refund:${r.status}`);
}

// ---- InstaPay (manual transfer) -------------------------------------------------------------------------------------

/** The merchant confirms the transfer arrived: exactly once; a second tap is a no-op. */
export function confirmInstapay(
  db: SyncSql,
  a: {
    storeId: string;
    orderId: string;
    actorUserId: string | null;
    proofSubmitted: boolean;
    now?: number;
  }
): { changed: boolean; orderId: string; status: string; approvedReceiptIds?: string[] } {
  const now = a.now ?? Date.now();
  return db.transactionSync(() => {
    const o = loadOrder(db, a.storeId, a.orderId);
    // a receipt the shopper submitted on this DO is proof too (INSTAPAY-DO-1), whatever the caller passed
    ensureReceiptSchema(db);
    const hasReceipt =
      (db.all(
        "SELECT COUNT(*) AS c FROM instapay_order_receipts WHERE store_id = ? AND order_id = ? AND status = 'submitted'",
        [a.storeId, a.orderId]
      )[0].c as number) > 0;
    const proofSubmitted = a.proofSubmitted || hasReceipt;
    if (o.status !== AWAITING_PAYMENT_CONFIRMATION) {
      const done = db.all(
        "SELECT 1 AS x FROM payments WHERE order_id = ? AND provider = 'instapay' AND status = 'completed'",
        [o.id]
      )[0];
      if (done && o.status !== 'cancelled' && o.status !== 'refunded')
        return { changed: false, orderId: o.id, status: o.status };
      if (o.status === 'cancelled')
        throw err(
          'INSTAPAY_ORDER_CANCELLED',
          'This order was cancelled (the confirmation window may have expired)'
        );
      throw err('INSTAPAY_NOT_AWAITING', 'This order is not waiting for an InstaPay confirmation');
    }
    const pay = db.all(
      "SELECT id, amount, metadata FROM payments WHERE order_id = ? AND provider = 'instapay' AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
      [o.id]
    )[0];
    if (!pay) throw err('INSTAPAY_NOT_AWAITING', 'No pending InstaPay payment');
    const exp = o.payment_confirmation_expires_at;
    if (exp !== null && exp <= now && !proofSubmitted)
      throw err(
        'INSTAPAY_CONFIRMATION_EXPIRED',
        'The confirmation window for this order has expired'
      );
    const claimed = db.run(
      "UPDATE orders SET status = 'confirmed', payment_status = 'paid', updated_at = ? WHERE id = ? AND store_id = ? AND status = ?",
      [now, o.id, a.storeId, AWAITING_PAYMENT_CONFIRMATION]
    );
    if (claimed.changes < 1)
      throw err('INSTAPAY_NOT_AWAITING', 'The order changed while confirming');
    db.run(
      "UPDATE payments SET status = 'completed', paid_at = ?, metadata = ?, updated_at = ? WHERE id = ?",
      [
        now,
        JSON.stringify({
          ...parse(pay.metadata),
          confirmedVia: 'merchant_instapay_confirm',
          confirmedBy: a.actorUserId,
          confirmedAt: new Date(now).toISOString(),
        }),
        now,
        pay.id,
      ]
    );
    addOrderEvent(
      db,
      a.storeId,
      o.id,
      AWAITING_PAYMENT_CONFIRMATION,
      'confirmed',
      { via: 'instapay_confirm', amountMinor: pay.amount },
      now,
      a.actorUserId
    );
    addPaymentEvent(db, {
      storeId: a.storeId,
      paymentId: pay.id as string,
      orderId: o.id,
      eventType: 'admin_action',
      from: 'pending',
      to: 'completed',
      provider: 'instapay',
      userId: a.actorUserId,
      details: { reason: 'merchant_confirmed_instapay_transfer', amountMinor: pay.amount },
      now,
    });
    // the merchant's confirm IS the approval of the shopper's submitted receipts, in this same section
    const approvedReceiptIds = approveSubmittedReceipts(db, {
      storeId: a.storeId,
      orderId: o.id,
      actorId: a.actorUserId,
      now,
    });
    return { changed: true, orderId: o.id, status: 'confirmed', approvedReceiptIds };
  });
}

/** Cancel one awaiting order whose hold ran out (stock and coupon come back through the cancel path); safe against a concurrent confirm. */
export function expireInstapay(
  db: SyncSql,
  a: { storeId: string; orderId: string; proofSubmitted: boolean; now?: number }
): 'expired' | 'skipped' {
  const now = a.now ?? Date.now();
  return db.transactionSync(() => {
    const o = db.all(
      'SELECT id, status, payment_confirmation_expires_at AS exp FROM orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL',
      [a.orderId, a.storeId]
    )[0];
    if (
      !o ||
      o.status !== AWAITING_PAYMENT_CONFIRMATION ||
      o.exp === null ||
      (o.exp as number) > now ||
      a.proofSubmitted
    )
      return 'skipped';
    cancelOrder(db, { storeId: a.storeId, orderId: a.orderId, now });
    db.run(
      "UPDATE orders SET notes = coalesce(notes || char(10), '') || '[auto-cancelled: InstaPay confirmation window expired]' WHERE id = ? AND store_id = ?",
      [a.orderId, a.storeId]
    );
    const pay = db.all(
      "SELECT id FROM payments WHERE order_id = ? AND provider = 'instapay' AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
      [a.orderId]
    )[0];
    if (pay) {
      db.run("UPDATE payments SET status = 'expired', updated_at = ? WHERE id = ?", [now, pay.id]);
      addPaymentEvent(db, {
        storeId: a.storeId,
        paymentId: pay.id as string,
        orderId: a.orderId,
        eventType: 'status_change',
        from: 'pending',
        to: 'expired',
        provider: 'instapay',
        details: { reason: 'instapay_confirmation_window_expired' },
        now,
      });
    }
    return 'expired';
  });
}

/**
 * Operator action for a held refund webhook (Kashier: the webhook's id may differ from the id the refund API answered
 * with): "this provider refund IS that claim's refund". Moves no money; consumes the claim, records the provider id as seen,
 * audits the operator. Refuses a claim that did not execute or is already closed. Replay-safe.
 */
export function matchRefundToClaim(
  db: SyncSql,
  a: {
    storeId: string;
    claimId: string;
    providerRefundId: string;
    actorUserId: string;
    /** The order the operator matched from (the route's :orderId): a claim of another order is not found. */
    orderId?: string;
    now?: number;
  }
): 'matched' | 'already_matched' {
  need(a.providerRefundId, 'providerRefundId');
  need(a.actorUserId, 'actorUserId');
  const now = a.now ?? Date.now();
  return db.transactionSync(() => {
    const claim = findClaim(db, a.storeId, a.claimId);
    const p = loadPayment(db, a.storeId, claim.paymentId);
    if (a.orderId !== undefined && p.order_id !== a.orderId)
      throw err('CLAIM_NOT_FOUND', 'no such refund claim on this order', 404);
    const has = (type: string) =>
      db.all(
        "SELECT 1 AS x FROM payment_events WHERE payment_id = ? AND event_type = ? AND json_extract(details, '$.claimId') = ?",
        [p.id, type, a.claimId]
      ).length > 0;
    if (has(REFUND_ABSORBED_EVENT)) return 'already_matched';
    if (!has(REFUND_EXECUTED_EVENT))
      throw err('CLAIM_NOT_EXECUTED', 'claim has no executed refund to match', 409);
    if (
      has(REFUND_RELEASED_EVENT) ||
      has(REFUND_INDETERMINATE_EVENT) ||
      has(REFUND_RECONCILED_EVENT)
    )
      throw err('CLAIM_CLOSED', 'claim is already closed', 409);
    // the id must be one a provider webhook delivered and we HELD on this payment, and not yet accounted: a typo must not
    // pre-mark a future real refund as seen
    if (readAccountedRefundEventIds(parse(p.metadata)).includes(a.providerRefundId))
      throw err('REFUND_ID_ACCOUNTED', 'that refund id is already accounted', 409);
    const held = db.all(
      "SELECT 1 AS x FROM payment_events WHERE payment_id = ? AND event_type = 'webhook' AND json_extract(details, '$.flavour') = 'refund' AND json_extract(details, '$.refundId') = ? AND json_extract(details, '$.heldUnaccountedRefund') = 1",
      [p.id, a.providerRefundId]
    );
    if (held.length === 0)
      throw err('NO_HELD_WEBHOOK', 'no held webhook for that refund id on this payment', 409);
    // the held webhook's amount, when it reported one, must equal the claim's (a 500 matched to a 2000 claim would mark the
    // 500 accounted without ever adding it)
    const reported = db.all(
      "SELECT json_extract(details, '$.reportedAmount') AS a FROM payment_events WHERE payment_id = ? AND event_type = 'webhook' AND json_extract(details, '$.refundId') = ? AND json_extract(details, '$.heldUnaccountedRefund') = 1 ORDER BY created_at DESC LIMIT 1",
      [p.id, a.providerRefundId]
    )[0]?.a;
    if (typeof reported === 'number' && reported !== claim.amount)
      throw err('AMOUNT_MISMATCH', 'the held webhook amount does not equal the claim amount', 409);
    addPaymentEvent(db, {
      storeId: a.storeId,
      paymentId: p.id,
      orderId: p.order_id,
      eventType: REFUND_ABSORBED_EVENT,
      provider: p.provider,
      userId: a.actorUserId,
      details: {
        claimId: a.claimId,
        refundId: a.providerRefundId,
        matchedBy: a.actorUserId,
        via: 'operator_match',
      },
      now,
    });
    const meta = parse(p.metadata);
    db.run('UPDATE payments SET metadata = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify({
        ...meta,
        [REFUND_EVENT_IDS_KEY]: appendRefundEventId(meta, a.providerRefundId),
        [REFUND_STATUS_BY_ID_KEY]: recordRefundStatus(meta, a.providerRefundId, 'completed'),
      }),
      now,
      p.id,
    ]);
    return 'matched';
  });
}

/**
 * Record a refund the merchant made OUTSIDE the platform (InstaPay: sent from their bank app) against the order's confirmed
 * InstaPay payment, in ONE section (Ruling NZ-MONEY-6; the Postgres twin is InstapayService.recordRefund under a row lock).
 * Idempotent on `referenceKey` (the normalised bank reference): a replay answers `duplicate: true` and writes nothing.
 * Refuses: no confirmed InstaPay payment (409), nothing left to refund (409), an amount above what is left (400).
 * A full refund flips `orders.payment_status` to refunded; the ORDER status flip (stock / coupon / loyalty effects) is the
 * caller's next step (OrderService.updateStatus), resumable: a replay of a full refund on an order not yet `refunded`
 * tells the caller to run it.
 */
export function recordInstapayRefund(
  db: SyncSql,
  a: {
    storeId: string;
    orderId: string;
    referenceKey: string;
    amountMinor: number;
    record: Record<string, unknown>;
    actorUserId: string | null;
    now?: number;
  }
): {
  duplicate: boolean;
  full: boolean;
  paymentId: string;
  fromStatus: string;
  status: string;
  refundedAmount: number;
  orderStatus: string;
} {
  need(a.orderId, 'orderId');
  need(a.referenceKey, 'referenceKey');
  if (!Number.isInteger(a.amountMinor) || a.amountMinor < 1)
    throw err('INVALID_REFUND_AMOUNT', 'amountMinor', 400);
  const now = a.now ?? Date.now();
  return db.transactionSync(() => {
    const order = loadOrder(db, a.storeId, a.orderId);
    const row = db.all(
      `SELECT id FROM payments WHERE order_id = ? AND provider = 'instapay'
         AND status IN ('completed', 'partially_refunded', 'refunded') ORDER BY created_at DESC LIMIT 1`,
      [a.orderId]
    )[0];
    if (!row) throw err('NO_INSTAPAY_PAYMENT', 'This order has no confirmed InstaPay payment', 409);
    const p = loadPayment(db, a.storeId, row.id as string);
    const meta = parse(p.metadata);
    const refunds = Array.isArray(meta.refunds)
      ? (meta.refunds as Array<Record<string, unknown>>)
      : [];
    if (refunds.some(r => r.referenceKey === a.referenceKey))
      return {
        duplicate: true,
        full: p.status === 'refunded',
        paymentId: p.id,
        fromStatus: p.status,
        status: p.status,
        refundedAmount: p.refunded_amount,
        orderStatus: order.status,
      };
    const remaining = p.amount - p.refunded_amount;
    if (remaining <= 0) throw err('ALREADY_REFUNDED', 'This payment is fully refunded', 409);
    if (a.amountMinor > remaining)
      throw err('INVALID_REFUND_AMOUNT', `Refund must be between 1 and ${remaining} piastres`, 400);
    const full = a.amountMinor === remaining;
    const status = full ? 'refunded' : 'partially_refunded';
    db.run(
      'UPDATE payments SET status = ?, refunded_amount = refunded_amount + ?, metadata = ?, updated_at = ? WHERE id = ?',
      [
        status,
        a.amountMinor,
        JSON.stringify({
          ...meta,
          refunds: [...refunds, { ...a.record, referenceKey: a.referenceKey }],
        }),
        now,
        p.id,
      ]
    );
    if (full)
      db.run(
        "UPDATE orders SET payment_status = 'refunded', updated_at = ? WHERE id = ? AND store_id = ?",
        [now, a.orderId, a.storeId]
      );
    addPaymentEvent(db, {
      storeId: a.storeId,
      paymentId: p.id,
      orderId: a.orderId,
      eventType: 'refund',
      from: p.status,
      to: status,
      provider: 'instapay',
      details: {
        reason: 'merchant_recorded_instapay_refund',
        amountMinor: a.amountMinor,
        reference: a.record.reference ?? null,
      },
      userId: a.actorUserId,
      now,
    });
    return {
      duplicate: false,
      full,
      paymentId: p.id,
      fromStatus: p.status,
      status,
      refundedAmount: p.refunded_amount + a.amountMinor,
      orderStatus: order.status,
    };
  });
}
