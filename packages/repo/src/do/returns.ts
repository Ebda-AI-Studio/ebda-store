import { MoneyError, type SyncSql } from './sync-sql';
import { allocatePartialReturn, splitByPaymentMix, type AllocationLine } from './return-allocation';
import {
  productReturnAdjustment,
  type ReturnLineInput,
  type SnapshotRung,
  type TierLadderSnapshot,
} from './return-adjustment';
import { applyWalletEntry, refundOrder, reverseOrderEffects } from './refund';
import {
  assertRefundable,
  assertWithinPaid,
  MANUAL_RETURN_METHODS,
  recordTrimmedCredit,
  refundableBalance,
} from './refundable';
import {
  addPaymentEvent,
  REFUND_CLAIM_EVENT,
  REFUND_EXECUTED_EVENT,
  REFUND_RECONCILED_EVENT,
  REFUND_RELEASED_EVENT,
} from './payments';
import { PROVIDER_TO_CASH_CODE, postEntry, systemAccountId, type JournalLine } from './ledger';

/**
 * The Return row lifecycle and the partial-return journal on the StoreDO (INFRA-CF-1 last-mile R1, Ruling CF-RETURNS-1).
 * Ports `ReturnService` (create, updateStatus / approve / reject / markReceived, updateTracking, complete) and
 * `postPartialReturnJournal` / `postAmountOnlyRefundJournal` of the Worker. Every operation is ONE section of the
 * StoreDO (`moneyOp` -> `runMoneyOp`, with the optional marker-row idempotency key `_money_ops`, Ruling CF-MONEY-1).
 *
 *   returnCreate     ReturnService.create             validation, claimed-quantity check, refund estimate, rows
 *   returnStatus     ReturnService.updateStatus       approve / reject / ship / receive / any status the route allows
 *   returnTracking   ReturnService.updateTracking
 *   returnClaim      ReturnService.complete (start)   status + atomic claim (`refunded_at`) + the plan the Worker needs for the
 *                                                     gateway call (full/partial, allocation, wallet share)
 *   returnFinish     ReturnService.complete (end)     the completion row, tier items, wallet credits, stock effects, arming
 *   returnRelease    complete()'s catch               releases the claim while no money moved
 *   journalPartialReturn / journalAmountOnlyRefund    the two GL adjustments of `partial-return-posting.ts`
 *
 * What the single thread replaces: `lockOrderReturns` / `lockOrderReturnsBounded` (advisory locks) become the claim itself
 * (`refunded_at`): a second claim on ANY return of the order is `RETURN_ORDER_BUSY` 409 (create and complete), so the
 * cumulative allocation never reads a sibling's work as "not there yet"; the `FOR UPDATE` of the sale entry is moot.
 *
 * Differences kept (found by the contract test): none in rows or answers; the refund money legs of a gateway completion are
 * still sent by the Worker (the provider call cannot live in a section) between `returnClaim` and `returnFinish`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const RETURN_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'shipped',
  'received',
  'inspecting',
  'completed',
  'cancelled',
] as const;
const GATEWAY_REFUND_METHODS = ['original', 'gateway', 'original_payment'];
const RETURN_WALLET_SHARE_KEY_PREFIX = 'return-wallet-share:';
const BACKORDER_CANCEL_MARKER = 'backorder_line_cancelled';

type Row = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

const sid = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || v.length < 1 || v.length > 200)
    throw new MoneyError('BAD_ARGS', `${what} is required`, 400);
  return v;
};
const optStr = (v: unknown, max = 4000): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > max) throw new MoneyError('BAD_ARGS', 'text', 400);
  return v;
};

// ---------------------------------------------------------------- readers

function loadReturn(db: SyncSql, storeId: string, returnId: string): Row {
  const r = db.all('SELECT * FROM returns WHERE id = ?1 AND store_id = ?2', [returnId, storeId])[0];
  if (!r) throw new MoneyError('NOT_FOUND', 'Return request not found', 404);
  return r;
}
function returnItems(db: SyncSql, returnId: string): Row[] {
  return db.all('SELECT * FROM return_items WHERE return_id = ?1 ORDER BY rowid', [returnId]);
}

interface OrderLine {
  id: string;
  productId: string;
  variantId: string | null;
  bundleGroupId: string | null;
  bundleName: string | null;
  quantity: number;
  price: number;
  listPrice: number | null;
  priceSource: string | null;
  priceTierMinQty: number | null;
  tierLadder: unknown;
  goldSnapshot: boolean;
  costPrice: number | null;
  productName: string;
}
function orderLines(db: SyncSql, orderId: string): OrderLine[] {
  return db
    .all(
      `SELECT id, product_id, variant_id, bundle_group_id, bundle_name, quantity, price, list_price, price_source,
              price_tier_min_qty, tier_ladder, gold_snapshot, cost_price, product_name
         FROM order_items WHERE order_id = ?1 ORDER BY rowid`,
      [orderId]
    )
    .map(r => {
      let ladder: unknown = null;
      if (typeof r.tier_ladder === 'string') {
        try {
          ladder = JSON.parse(r.tier_ladder);
        } catch {
          ladder = null;
        }
      }
      return {
        id: r.id as string,
        productId: r.product_id as string,
        variantId: (r.variant_id as string | null) ?? null,
        bundleGroupId: (r.bundle_group_id as string | null) ?? null,
        bundleName: (r.bundle_name as string | null) ?? null,
        quantity: r.quantity as number,
        price: r.price as number,
        listPrice: (r.list_price as number | null) ?? null,
        priceSource: (r.price_source as string | null) ?? null,
        priceTierMinQty: (r.price_tier_min_qty as number | null) ?? null,
        tierLadder: ladder,
        goldSnapshot: r.gold_snapshot !== null && r.gold_snapshot !== undefined,
        costPrice: (r.cost_price as number | null) ?? null,
        productName: r.product_name as string,
      };
    });
}

/** `loadBackorderCancelledQty`: units single-line backorder cancels took back, from their order_events markers. */
function backorderCancelled(
  db: SyncSql,
  storeId: string,
  orderId: string,
  excludeKey?: string
): { qty: Map<string, number>; reasons: Map<string, string | null> } {
  const qty = new Map<string, number>();
  const reasons = new Map<string, string | null>();
  for (const m of db.all(
    'SELECT metadata FROM order_events WHERE store_id = ?1 AND order_id = ?2 AND to_status = ?3',
    [storeId, orderId, BACKORDER_CANCEL_MARKER]
  )) {
    let meta: {
      refundKey?: unknown;
      reason?: unknown;
      items?: Array<{ orderItemId?: unknown; quantity?: unknown }>;
    } | null = null;
    try {
      meta = JSON.parse(String(m.metadata));
    } catch {
      meta = null;
    }
    if (typeof meta?.refundKey !== 'string') continue;
    reasons.set(meta.refundKey, typeof meta.reason === 'string' ? meta.reason : null);
    if (meta.refundKey === excludeKey || !Array.isArray(meta.items)) continue;
    for (const it of meta.items) {
      if (typeof it?.orderItemId !== 'string' || typeof it?.quantity !== 'number') continue;
      qty.set(it.orderItemId, (qty.get(it.orderItemId) ?? 0) + it.quantity);
    }
  }
  return { qty, reasons };
}

/** `loadPriorReversedQty`: completed returns (type return / refund) plus backorder cancels, excluding `excludeKey`. */
function priorReversed(db: SyncSql, storeId: string, orderId: string, excludeKey?: string) {
  const bo = backorderCancelled(db, storeId, orderId, excludeKey);
  const prevQty = bo.qty;
  const reasons = bo.reasons;
  let prevAdjustment = 0;
  for (const ret of db.all(
    `SELECT id, reason FROM returns WHERE store_id = ?1 AND order_id = ?2 AND status = 'completed' AND type IN ('return', 'refund')`,
    [storeId, orderId]
  )) {
    reasons.set(ret.id as string, (ret.reason as string | null) ?? null);
    if (ret.id === excludeKey) continue;
    for (const it of db.all(
      'SELECT order_item_id, quantity, tier_adjustment FROM return_items WHERE return_id = ?1',
      [ret.id]
    )) {
      prevQty.set(
        it.order_item_id as string,
        (prevQty.get(it.order_item_id as string) ?? 0) + num(it.quantity)
      );
      prevAdjustment += num(it.tier_adjustment);
    }
  }
  return { prevQty, reasons, prevAdjustment };
}

function orderMoney(db: SyncSql, storeId: string, orderId: string) {
  const o = db.all(
    `SELECT id, customer_id, order_number, status, subtotal, discount, tax, tax_included_in_price, shipping, wallet_amount, total,
            delivered_at, updated_at, locale
       FROM orders WHERE id = ?1 AND store_id = ?2 AND deleted_at IS NULL`,
    [orderId, storeId]
  )[0];
  return o
    ? {
        id: o.id as string,
        customerId: (o.customer_id as string | null) ?? null,
        orderNumber: o.order_number as string,
        status: o.status as string,
        subtotal: num(o.subtotal),
        discount: num(o.discount),
        tax: num(o.tax),
        taxIncludedInPrice: o.tax_included_in_price === 1,
        shipping: num(o.shipping),
        walletAmount: num(o.wallet_amount),
        total: num(o.total),
        deliveredAt: (o.delivered_at as number | null) ?? null,
        updatedAt: num(o.updated_at),
      }
    : null;
}

// ---------------------------------------------------------------- tier adjustment (ReturnService.lineAdjustmentsFrom)

interface ReturnLineAdjustment {
  returnItemId: string;
  orderItemId: string;
  productName: string;
  quantity: number;
  keptQty: number;
  tierMinQty: number | null;
  standardRefund: number;
  adjustment: number;
  adjustedRefund: number;
  shortfall: number;
  carriedIn: number;
  carryDelta: number;
  carryWaived: number;
  keptUnitMinor: number;
  reason: 'none' | 'kept_below_tier' | 'released';
  overridden: boolean;
  overrideReason: string | null;
}
type Overrides = Record<string, { amountMinor: number; reason: string }>;

function ladderOf(raw: unknown): TierLadderSnapshot | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as { rungs?: unknown; groupPercentMinor?: unknown };
  if (!Array.isArray(o.rungs)) return null;
  const g = o.groupPercentMinor;
  if (g !== null && !Number.isInteger(g)) return null;
  const rungs: SnapshotRung[] = [];
  for (const r of o.rungs) {
    const x = r as { minQty?: unknown; priceMinor?: unknown; variant?: unknown; group?: unknown };
    if (
      !Number.isInteger(x?.minQty) ||
      !Number.isInteger(x?.priceMinor) ||
      typeof x.variant !== 'boolean' ||
      typeof x.group !== 'boolean'
    )
      return null;
    rungs.push({
      minQty: x.minQty as number,
      priceMinor: x.priceMinor as number,
      variant: x.variant,
      group: x.group,
    });
  }
  return { rungs, groupPercentMinor: g as number | null };
}

function lineAdjustmentsFrom(
  orderItems: readonly OrderLine[],
  prevQty: ReadonlyMap<string, number>,
  retainedRows: ReadonlyArray<{ orderItemId: string; tierAdjustment: number; tierCarry: number }>,
  items: Array<{ id: string; orderItemId: string; quantity: number; productName: string }>,
  overrides: Overrides
): { lines: ReturnLineAdjustment[]; total: number } {
  for (const key of Object.keys(overrides))
    if (!items.some(i => i.id === key))
      throw new MoneyError(
        'OVERRIDE_UNKNOWN_ITEM',
        'A refund override names an item that is not on this return.',
        400
      );
  const lineById = new Map(orderItems.map(o => [o.id, o]));
  const scopeOf = (o: OrderLine): string | null => (o.bundleGroupId === null ? o.productId : null);

  const running = new Map(prevQty);
  const returningOf = new Map<string, number>();
  for (const it of items) {
    const oi = lineById.get(it.orderItemId);
    if (!oi) continue;
    const before = Math.min(running.get(oi.id) ?? 0, oi.quantity);
    const returning = Math.max(0, Math.min(it.quantity, oi.quantity - before));
    running.set(oi.id, before + returning);
    returningOf.set(it.id, returning);
  }

  const retainedByProduct = new Map<string, number>();
  const carriedByProduct = new Map<string, number>();
  for (const r of retainedRows) {
    const oi = lineById.get(r.orderItemId);
    const scope = oi ? scopeOf(oi) : null;
    if (scope !== null) {
      retainedByProduct.set(scope, (retainedByProduct.get(scope) ?? 0) + r.tierAdjustment);
      carriedByProduct.set(scope, (carriedByProduct.get(scope) ?? 0) + r.tierCarry);
    }
  }

  const perItem = new Map<
    string,
    {
      adjustment: number;
      keptUnitMinor: number;
      keptQty: number;
      shortfall: number;
      carriedIn: number;
      carryDelta: number;
      carryWaived: number;
    }
  >();
  const products = new Set<string>();
  for (const it of items) {
    const oi = lineById.get(it.orderItemId);
    const scope = oi ? scopeOf(oi) : null;
    if (scope !== null && returningOf.has(it.id)) products.add(scope);
  }
  for (const productId of products) {
    const scopeLines = orderItems.filter(o => scopeOf(o) === productId);
    const scopeItems = items.filter(
      it => returningOf.has(it.id) && lineById.get(it.orderItemId)?.productId === productId
    );
    const res = productReturnAdjustment(
      scopeLines.map(
        (o): ReturnLineInput => ({
          key: o.id,
          variantId: o.variantId,
          quantity: o.quantity,
          paidUnitMinor: o.price,
          listMinor: o.listPrice,
          priceSource: (o.priceSource as ReturnLineInput['priceSource']) ?? null,
          tierMinQty: o.priceTierMinQty,
          ladder: ladderOf(o.tierLadder),
          returnedBefore: Math.min(prevQty.get(o.id) ?? 0, o.quantity),
          returning: scopeItems
            .filter(it => it.orderItemId === o.id)
            .reduce((n, it) => n + returningOf.get(it.id)!, 0),
        })
      ),
      scopeItems
        .filter(it => lineById.get(it.orderItemId)!.bundleGroupId === null)
        .map(it => ({ key: it.id, lineKey: it.orderItemId, returning: returningOf.get(it.id)! })),
      retainedByProduct.get(productId) ?? 0,
      Math.max(0, carriedByProduct.get(productId) ?? 0)
    );
    const waived = scopeItems.some(it => overrides[it.id] !== undefined);
    const carryOut = waived ? 0 : res.shortfall;
    res.items.forEach((r, i) =>
      perItem.set(r.key, {
        adjustment: r.adjustment,
        keptUnitMinor: r.keptUnitMinor,
        keptQty: res.keptQty,
        shortfall: i === 0 ? carryOut : 0,
        carriedIn: i === 0 ? res.carriedIn : 0,
        carryDelta: i === 0 ? carryOut - res.carriedIn : 0,
        carryWaived: i === 0 && waived ? res.shortfall : 0,
      })
    );
  }

  const lines: ReturnLineAdjustment[] = [];
  let total = 0;
  for (const it of items) {
    const oi = lineById.get(it.orderItemId);
    if (!oi || !returningOf.has(it.id)) continue;
    const returning = returningOf.get(it.id)!;
    const standardRefund = oi.price * returning;
    const computed = perItem.get(it.id) ?? {
      adjustment: 0,
      keptUnitMinor: oi.price,
      keptQty: oi.quantity - (running.get(oi.id) ?? 0),
      shortfall: 0,
      carriedIn: 0,
      carryDelta: 0,
      carryWaived: 0,
    };
    let adjustment = computed.adjustment;
    let overridden = false;
    let overrideReason: string | null = null;
    const ov = overrides[it.id];
    if (ov) {
      if (
        !Number.isInteger(ov.amountMinor) ||
        ov.amountMinor < 0 ||
        ov.amountMinor > standardRefund
      )
        throw new MoneyError(
          'OVERRIDE_OUT_OF_RANGE',
          'A refund override must be between 0 and the standard refund for that item.',
          400
        );
      adjustment = standardRefund - ov.amountMinor;
      overridden = true;
      overrideReason = ov.reason;
    }
    total += adjustment;
    lines.push({
      returnItemId: it.id,
      orderItemId: oi.id,
      productName: it.productName,
      quantity: returning,
      keptQty: computed.keptQty,
      tierMinQty: oi.priceSource === 'tier' ? oi.priceTierMinQty : null,
      standardRefund,
      adjustment,
      adjustedRefund: standardRefund - adjustment,
      shortfall: computed.shortfall,
      carriedIn: computed.carriedIn,
      carryDelta: computed.carryDelta,
      carryWaived: computed.carryWaived,
      keptUnitMinor: computed.keptUnitMinor,
      reason: adjustment > 0 ? 'kept_below_tier' : adjustment < 0 ? 'released' : 'none',
      overridden,
      overrideReason,
    });
  }
  return { lines, total };
}

function computeLineAdjustments(
  db: SyncSql,
  storeId: string,
  returnId: string | null,
  orderId: string,
  lines: OrderLine[],
  items: Array<{ id: string; orderItemId: string; quantity: number; productName: string }>,
  overrides: Overrides
) {
  const { prevQty } = priorReversed(db, storeId, orderId, returnId ?? undefined);
  const retained = db
    .all(
      `SELECT ri.order_item_id, ri.tier_adjustment, ri.tier_carry
         FROM return_items ri JOIN returns r ON r.id = ri.return_id
        WHERE r.store_id = ?1 AND r.order_id = ?2 AND r.status = 'completed' AND r.id <> ?3`,
      [storeId, orderId, returnId ?? '']
    )
    .map(r => ({
      orderItemId: r.order_item_id as string,
      tierAdjustment: num(r.tier_adjustment),
      tierCarry: num(r.tier_carry),
    }));
  return lineAdjustmentsFrom(lines, prevQty, retained, items, overrides);
}

// ---------------------------------------------------------------- create

export interface ReturnCreateArgs {
  storeId: string;
  orderId: string;
  /** the shopper (required unless `byMerchant`, which uses the order's own customer) */
  customerId?: string;
  type: string;
  reason: string;
  reasonDetail?: string;
  customerNotes?: string;
  items?: Array<{
    orderItemId: string;
    productId: string;
    productName: string;
    quantity: number;
    reason?: string;
    condition?: string;
    /** merchant-created returns only: `false` = the goods do NOT go back on the shelf (stored as condition `no_restock`). */
    restock?: boolean;
  }>;
  bundleGroupIds?: string[];
  /**
   * STORE-QA-76: the MERCHANT opens this return from the admin (a phone request, a partial refund). The order's own customer
   * is used (no customer match), the customer-facing return window does not bind the merchant's own decision, and the item
   * list may carry a per-line `restock` choice. Never set from a shopper-facing route. A guest order (no customer) is allowed:
   * `returns.customer_id` is NOT NULL, so the row carries the `guest:<orderId>` marker (GUEST-RET-1); it matches no account.
   */
  byMerchant?: boolean;
  now?: number;
}

/**
 * `returns.customer_id` is NOT NULL and a guest order has no account, so a merchant-opened return on a guest order stores this
 * marker (never a users.id: no wallet, no loyalty, no socket/email recipient is ever resolved from it).
 */
const GUEST_RETURN_PREFIX = 'guest:';
export const guestReturnCustomerId = (orderId: string): string =>
  `${GUEST_RETURN_PREFIX}${orderId}`;
export const isGuestReturnCustomer = (customerId: unknown): boolean =>
  typeof customerId === 'string' && customerId.startsWith(GUEST_RETURN_PREFIX);

/** return_items.condition marker: the merchant chose not to restock this line (damaged / not resellable). */
const NO_RESTOCK_CONDITION = 'no_restock';

function returnNumber(now: number): string {
  const b = new Uint8Array(3);
  crypto.getRandomValues(b);
  const hex = Array.from(b, x => x.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return `RET-${now.toString(36).toUpperCase()}-${hex}`;
}

/** Another return of the order is being completed right now (its claim is `refunded_at`): the lock of `lockOrderReturns`. */
function assertOrderNotBusy(db: SyncSql, storeId: string, orderId: string, exceptReturn?: string) {
  const busy = db.all(
    `SELECT id FROM returns WHERE store_id = ?1 AND order_id = ?2 AND status IN ('received', 'inspecting')
        AND refunded_at IS NOT NULL AND id <> ?3 LIMIT 1`,
    [storeId, orderId, exceptReturn ?? '']
  )[0];
  if (busy)
    throw new MoneyError(
      'RETURN_ORDER_BUSY',
      'Another return on this order is being processed. Please try again in a moment.',
      409
    );
}

export function createReturn(db: SyncSql, a: ReturnCreateArgs): { returnId: string } {
  const storeId = sid(a.storeId, 'storeId');
  const now = a.now ?? Date.now();
  if (!['return', 'exchange', 'refund'].includes(a.type))
    throw new MoneyError('BAD_ARGS', 'type', 400);
  const reason = optStr(a.reason, 2000);
  if (reason === null) throw new MoneyError('BAD_ARGS', 'reason is required', 400);

  return db.transactionSync(() => {
    const o = db.all(
      a.byMerchant
        ? `SELECT id, order_number, updated_at, delivered_at, customer_id FROM orders
            WHERE id = ?1 AND store_id = ?2 AND status = 'delivered' AND deleted_at IS NULL`
        : `SELECT id, order_number, updated_at, delivered_at, customer_id FROM orders
            WHERE id = ?1 AND store_id = ?2 AND customer_id = ?3 AND status = 'delivered' AND deleted_at IS NULL`,
      a.byMerchant
        ? [sid(a.orderId, 'orderId'), storeId]
        : [sid(a.orderId, 'orderId'), storeId, sid(a.customerId, 'customerId')]
    )[0];
    if (!o)
      throw new MoneyError('INVALID_ORDER', 'Order not found or not eligible for return', 400);
    const returnCustomerId = a.byMerchant
      ? typeof o.customer_id === 'string'
        ? o.customer_id
        : guestReturnCustomerId(o.id as string)
      : (a.customerId as string);
    const lines = orderLines(db, o.id as string);

    // the merchant's published return window binds the seller (evaluateReturnWindow)
    const days = (
      db.all('SELECT return_window_days FROM store_config WHERE store_id = ?1', [storeId])[0] as
        | { return_window_days: number | null }
        | undefined
    )?.return_window_days;
    if (!a.byMerchant && days !== null && days !== undefined) {
      const closesAt = days > 0 ? num(o.delivered_at ?? o.updated_at) + days * DAY_MS : null;
      if (days <= 0 || now > (closesAt as number))
        throw new MoneyError(
          'RETURN_WINDOW_CLOSED',
          days <= 0
            ? 'This store does not accept returns'
            : 'The return window for this order has closed',
          422,
          {
            reason: days <= 0 ? 'NOT_ACCEPTED' : 'EXPIRED',
            returnWindowDays: days,
            closesAt: closesAt === null ? null : new Date(closesAt).toISOString(),
          }
        );
    }

    type In = NonNullable<ReturnCreateArgs['items']>[number];
    const groupItems: In[] = [];
    for (const groupId of Array.from(new Set(a.bundleGroupIds ?? []))) {
      const groupLines = lines.filter(l => l.bundleGroupId === groupId);
      if (groupLines.length === 0)
        throw new MoneyError(
          'INVALID_BUNDLE_GROUP',
          `Bundle group ${groupId} was not found on this order`,
          400
        );
      for (const l of groupLines)
        groupItems.push({
          orderItemId: l.id,
          productId: l.productId,
          productName: l.productName,
          quantity: l.quantity,
        });
    }
    for (const item of a.items ?? []) {
      const line = lines.find(l => l.id === item.orderItemId);
      if (line?.bundleGroupId)
        throw new MoneyError(
          'bundle_returns_are_atomic',
          `"${line.bundleName ?? 'This bundle'}" can only be returned as a complete box. Select the bundle group instead of an individual component.`,
          422
        );
    }
    if (a.type === 'exchange') {
      const gold = lines.find(
        l => (a.items ?? []).some(i => i.orderItemId === l.id) && l.goldSnapshot
      );
      if (gold)
        throw new MoneyError(
          'GOLD_EXCHANGE_UNSUPPORTED',
          'A gold-priced piece cannot be exchanged. Return it and place a new order.',
          409,
          { messageAr: 'القطعة المسعّرة بالدهب مبتتبدّلش. رجّعها واعمل طلب جديد.' }
        );
    }
    const items: In[] = [...(a.items ?? []), ...groupItems];
    if (items.length === 0)
      throw new MoneyError(
        'NO_ITEMS',
        'At least one item or bundle group must be selected for return',
        400
      );

    assertOrderNotBusy(db, storeId, o.id as string);
    const claimed = backorderCancelled(db, storeId, o.id as string).qty;
    for (const r of db.all(
      `SELECT ri.order_item_id, ri.quantity FROM return_items ri JOIN returns r ON r.id = ri.return_id
        WHERE r.store_id = ?1 AND r.order_id = ?2 AND r.status NOT IN ('rejected', 'cancelled')`,
      [storeId, o.id]
    ))
      claimed.set(
        r.order_item_id as string,
        (claimed.get(r.order_item_id as string) ?? 0) + num(r.quantity)
      );
    for (const item of items) {
      const line = lines.find(l => l.id === item.orderItemId);
      if (!line)
        throw new MoneyError('INVALID_ITEM', `Order item ${item.orderItemId} not found`, 400);
      if (!Number.isInteger(item.quantity) || item.quantity < 1)
        throw new MoneyError('INVALID_QUANTITY', 'Quantity must be at least 1', 400);
      const already = claimed.get(item.orderItemId) ?? 0;
      if (already + item.quantity > line.quantity)
        throw new MoneyError(
          'INVALID_QUANTITY',
          'Quantity exceeds remaining returnable quantity for this item',
          400
        );
      claimed.set(item.orderItemId, already + item.quantity);
    }

    const gross = items.reduce(
      (t, item) => t + (lines.find(l => l.id === item.orderItemId)?.price ?? 0) * item.quantity,
      0
    );
    const thisQty = new Map<string, number>();
    for (const item of items)
      thisQty.set(item.orderItemId, (thisQty.get(item.orderItemId) ?? 0) + item.quantity);
    const fullEstimate =
      lines.length > 0 && lines.every(l => (thisQty.get(l.id) ?? 0) >= l.quantity);
    const estimatedAdjustment =
      fullEstimate || !lines.some(l => l.priceSource === 'tier')
        ? 0
        : computeLineAdjustments(
            db,
            storeId,
            null,
            o.id as string,
            lines,
            items.map((item, i) => ({
              id: `estimate-${i}`,
              orderItemId: item.orderItemId,
              quantity: item.quantity,
              productName: item.productName,
            })),
            {}
          ).total;

    const returnId = crypto.randomUUID();
    db.run(
      `INSERT INTO returns (id, store_id, order_id, customer_id, return_number, type, status, reason, reason_detail, refund_amount,
                            customer_notes, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8, ?9, ?10, ?11, ?11)`,
      [
        returnId,
        storeId,
        o.id,
        returnCustomerId,
        returnNumber(now),
        a.type,
        reason,
        optStr(a.reasonDetail),
        Math.max(0, gross - estimatedAdjustment),
        optStr(a.customerNotes),
        now,
      ]
    );
    for (const item of items)
      db.run(
        `INSERT INTO return_items (id, return_id, order_item_id, product_id, product_name, quantity, reason, condition)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        [
          crypto.randomUUID(),
          returnId,
          item.orderItemId,
          sid(item.productId, 'productId'),
          sid(item.productName, 'productName'),
          item.quantity,
          optStr(item.reason, 2000),
          a.byMerchant && item.restock === false
            ? NO_RESTOCK_CONDITION
            : item.condition === NO_RESTOCK_CONDITION
              ? null // the marker is the merchant's alone: a shopper-supplied value never skips a restock
              : optStr(item.condition, 200),
        ]
      );
    return { returnId };
  });
}

// ---------------------------------------------------------------- status / tracking

export function setReturnStatus(
  db: SyncSql,
  a: {
    storeId: string;
    returnId: string;
    status: string;
    userId: string;
    notes?: string;
    now?: number;
  }
): { returnId: string; status: string } {
  const now = a.now ?? Date.now();
  if (!(RETURN_STATUSES as readonly string[]).includes(a.status))
    throw new MoneyError('BAD_STATUS', 'status', 400);
  return db.transactionSync(() => {
    loadReturn(db, a.storeId, sid(a.returnId, 'returnId'));
    const sets: string[] = ['status = ?1', 'updated_at = ?2'];
    const params: unknown[] = [a.status, now];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = ?${params.length}`);
    };
    if (a.notes !== undefined) set('admin_notes', optStr(a.notes));
    switch (a.status) {
      case 'approved':
        set('approved_by', sid(a.userId, 'userId'));
        set('approved_at', now);
        break;
      case 'rejected':
        set('rejected_by', sid(a.userId, 'userId'));
        set('rejected_at', now);
        if (a.notes !== undefined) set('rejection_reason', optStr(a.notes));
        break;
      case 'shipped':
        set('shipped_at', now);
        break;
      case 'received':
        set('received_at', now);
        break;
      case 'completed':
        set('refunded_at', now);
        break;
    }
    params.push(a.returnId, a.storeId);
    db.run(
      `UPDATE returns SET ${sets.join(', ')} WHERE id = ?${params.length - 1} AND store_id = ?${params.length}`,
      params
    );
    return { returnId: a.returnId, status: a.status };
  });
}

export function setReturnTracking(
  db: SyncSql,
  a: { storeId: string; returnId: string; trackingNumber: string; now?: number }
): { returnId: string } {
  return db.transactionSync(() => {
    loadReturn(db, a.storeId, sid(a.returnId, 'returnId'));
    db.run(
      'UPDATE returns SET tracking_number = ?1, updated_at = ?2 WHERE id = ?3 AND store_id = ?4',
      [optStr(a.trackingNumber, 200), a.now ?? Date.now(), a.returnId, a.storeId]
    );
    return { returnId: a.returnId };
  });
}

// ---------------------------------------------------------------- refund claims of a return (payment.factory twins)

function refundEvents(
  db: SyncSql,
  storeId: string,
  orderId: string,
  refundKey: string,
  types: string[]
) {
  return db
    .all(
      `SELECT payment_id, event_type, provider, details FROM payment_events
        WHERE store_id = ?1 AND order_id = ?2 AND event_type IN (${types.map(() => '?').join(', ')})
          AND json_extract(details, '$.refundKey') = ?${types.length + 3}`,
      [storeId, orderId, ...types, refundKey]
    )
    .map(r => {
      let d: Record<string, unknown> = {};
      try {
        d = JSON.parse(String(r.details)) as Record<string, unknown>;
      } catch {
        d = {};
      }
      return {
        paymentId: r.payment_id as string,
        type: r.event_type as string,
        provider: (r.provider as string | null) ?? null,
        d,
      };
    });
}
/** findOutstandingRefundClaims: claims for `refundKey` not yet released (the claim row of an unreleased refund). */
function outstandingClaims(
  db: SyncSql,
  storeId: string,
  orderId: string,
  refundKey: string
): string[] {
  const claimed = new Set<string>();
  const released = new Set<string>();
  for (const e of refundEvents(db, storeId, orderId, refundKey, [
    REFUND_CLAIM_EVENT,
    REFUND_RELEASED_EVENT,
  ])) {
    const id = e.d.claimId;
    if (typeof id !== 'string') continue;
    (e.type === REFUND_CLAIM_EVENT ? claimed : released).add(id);
  }
  return [...claimed].filter(id => !released.has(id));
}
/** reconcileOutstandingRefundClaims: a non-gateway completion is the merchant settling an indeterminate gateway refund. */
function reconcileClaims(
  db: SyncSql,
  a: {
    storeId: string;
    orderId: string;
    refundKey: string;
    refundMethod: string;
    userId: string;
    now: number;
  }
): string[] {
  const claims = new Map<string, { paymentId: string; provider: string | null; amount: unknown }>();
  const closed = new Set<string>();
  for (const e of refundEvents(db, a.storeId, a.orderId, a.refundKey, [
    REFUND_CLAIM_EVENT,
    REFUND_EXECUTED_EVENT,
    REFUND_RELEASED_EVENT,
    REFUND_RECONCILED_EVENT,
  ])) {
    const id = e.d.claimId;
    if (typeof id !== 'string') continue;
    if (e.type === REFUND_CLAIM_EVENT)
      claims.set(id, { paymentId: e.paymentId, provider: e.provider, amount: e.d.amount });
    else closed.add(id);
  }
  const open = [...claims].filter(([id]) => !closed.has(id));
  for (const [claimId, c] of open)
    addPaymentEvent(db, {
      storeId: a.storeId,
      paymentId: c.paymentId,
      orderId: a.orderId,
      eventType: REFUND_RECONCILED_EVENT,
      provider: c.provider,
      details: {
        reason: 'reconciled_by_merchant',
        claimId,
        amount: typeof c.amount === 'number' ? c.amount : null,
        refundKey: a.refundKey,
        refundMethod: a.refundMethod,
        reconciledBy: a.userId ?? null,
      },
      now: a.now,
    });
  return open.map(([id]) => id);
}

// ---------------------------------------------------------------- complete: the plan

export interface PartialAllocation {
  cashCredit: number;
  returnedLineCount: number;
  allLinesNowReturned: boolean;
  walletShare: number;
  gatewayShare: number;
}
export interface ReturnPlan {
  returnId: string;
  orderId: string | null;
  customerId: string;
  type: string;
  isInventoryRestoring: boolean;
  isFullReturn: boolean;
  isGatewayRefund: boolean;
  partial: PartialAllocation | null;
  tierLines: ReturnLineAdjustment[];
  tierTotal: number;
  /** what the completion row records as `refund_amount` when known (the partial allocation) */
  allocatedAmount: number | null;
  /** store credit that lands in the wallet (null: wallet off / not applicable) */
  walletCreditAmount: number | null;
  walletShare: number;
  skipProvider: boolean;
  items: Array<{ orderItemId: string; quantity: number }>;
  /** order items whose goods the merchant chose NOT to put back on the shelf (STORE-QA-76): no stock move, no inventory GL reversal */
  noRestockItemIds: string[];
  /** open (unreleased) refund claims for `return:<id>`: a gateway refund of this return may already have gone out */
  outstandingClaims: string[];
}

function allocateThisReturn(
  db: SyncSql,
  storeId: string,
  returnId: string,
  orderId: string,
  lines: AllocationLine[],
  items: Array<{ orderItemId: string; quantity: number }>,
  thisAdjustment: number
): PartialAllocation {
  const { prevQty, prevAdjustment } = priorReversed(db, storeId, orderId, returnId);
  const order = orderMoney(db, storeId, orderId);
  const base = {
    subtotal: order?.subtotal ?? 0,
    discount: order?.discount ?? 0,
    tax: order?.tax ?? 0,
    taxIncludedInPrice: order?.taxIncludedInPrice ?? false,
  };
  const alloc = allocatePartialReturn({
    ...base,
    lines,
    prevQty,
    requested: items.map(i => ({ orderItemId: i.orderItemId, quantity: i.quantity })),
    prevAdjustment,
    thisAdjustment,
  });
  const thisQty = new Map<string, number>();
  for (const { line, qty } of alloc.returnedLines)
    thisQty.set(line.id, (thisQty.get(line.id) ?? 0) + qty);
  let split = { walletShare: 0, gatewayShare: alloc.cashCredit };
  if ((order?.walletAmount ?? 0) > 0) {
    const prior = allocatePartialReturn({
      ...base,
      lines,
      prevQty: new Map(),
      requested: [...prevQty].map(([orderItemId, quantity]) => ({ orderItemId, quantity })),
      thisAdjustment: prevAdjustment,
    });
    split = splitByPaymentMix({
      cashCredit: alloc.cashCredit,
      prevCash: prior.cashCredit,
      total: order?.total ?? 0,
      walletAmount: order?.walletAmount ?? 0,
    });
  }
  return {
    ...split,
    cashCredit: alloc.cashCredit,
    returnedLineCount: alloc.returnedLines.length,
    allLinesNowReturned: lines.every(
      l => (prevQty.get(l.id) ?? 0) + (thisQty.get(l.id) ?? 0) >= l.quantity
    ),
  };
}

function computeStoreCreditAmount(
  db: SyncSql,
  storeId: string,
  returnId: string,
  orderId: string,
  lines: AllocationLine[],
  items: Array<{ orderItemId: string; quantity: number }>,
  isFullReturn: boolean,
  thisAdjustment: number
): number {
  const { prevQty, prevAdjustment } = priorReversed(db, storeId, orderId, returnId);
  const order = orderMoney(db, storeId, orderId);
  const alloc = allocatePartialReturn({
    subtotal: order?.subtotal ?? 0,
    discount: order?.discount ?? 0,
    tax: order?.tax ?? 0,
    taxIncludedInPrice: order?.taxIncludedInPrice ?? false,
    lines,
    prevQty,
    requested: items.map(i => ({ orderItemId: i.orderItemId, quantity: i.quantity })),
    prevAdjustment,
    thisAdjustment,
  });
  if (!isFullReturn) return alloc.cashCredit;
  return Math.max(0, alloc.cashCredit + (order?.shipping ?? 0) - (order?.walletAmount ?? 0));
}

/** The decisions `ReturnService.complete` makes before and after the provider call, from the DO's own rows. */
function planReturn(
  db: SyncSql,
  storeId: string,
  ret: Row,
  refundMethod: string,
  overrides: Overrides,
  walletFeature: boolean
): ReturnPlan {
  const returnId = ret.id as string;
  const orderId = (ret.order_id as string | null) ?? null;
  const type = ret.type as string;
  const items = returnItems(db, returnId).map(r => ({
    id: r.id as string,
    orderItemId: r.order_item_id as string,
    quantity: num(r.quantity),
    productName: r.product_name as string,
    noRestock: r.condition === NO_RESTOCK_CONDITION,
  }));
  const isInventoryRestoring = type === 'return' || type === 'refund';
  const isGatewayRefund = GATEWAY_REFUND_METHODS.includes(refundMethod);
  // a guest has no wallet to credit: store credit cannot be the refund method (cash / bank / manual / the gateway can)
  if (isGuestReturnCustomer(ret.customer_id) && refundMethod === 'store_credit')
    throw new MoneyError(
      'GUEST_STORE_CREDIT',
      'This order was placed as a guest and has no wallet, so it cannot be refunded as store credit. Choose cash, bank transfer or the original payment.',
      409
    );

  let isFullReturn = false;
  let lines: OrderLine[] = [];
  if (orderId) {
    lines = orderLines(db, orderId);
    const returned = new Map<string, number>();
    for (const it of items)
      returned.set(it.orderItemId, (returned.get(it.orderItemId) ?? 0) + it.quantity);
    isFullReturn = lines.length > 0 && lines.every(l => (returned.get(l.id) ?? 0) >= l.quantity);
  }
  const allocLines: AllocationLine[] = lines.map(l => ({
    id: l.id,
    quantity: l.quantity,
    price: l.price,
    priceSource: l.priceSource,
  }));

  // a whole-order return runs the whole-order reversal (every unit back, the full inventory GL reversal): it cannot honour a
  // per-line "do not restock", so the merchant is told before any money moves (STORE-QA-76)
  if (isFullReturn && items.some(i => i.noRestock))
    throw new MoneyError(
      'FULL_RETURN_RESTOCK_ALL',
      'A return of every line restocks every line. Leave one unit out of the return, or restock all lines.',
      409
    );

  // An EXCHANGE must never move money (see ReturnService.complete).
  if (isGatewayRefund && type === 'exchange')
    throw new MoneyError(
      'EXCHANGE_CANNOT_REFUND_TO_GATEWAY',
      'An exchange swaps goods and does not refund the customer. Choose store credit or another method, or complete it as a return.',
      400
    );

  let partial: PartialAllocation | null = null;
  let tier: { lines: ReturnLineAdjustment[]; total: number } = { lines: [], total: 0 };
  if (Object.keys(overrides).length > 0 && (!isInventoryRestoring || isFullReturn))
    throw new MoneyError(
      'OVERRIDE_NOT_APPLICABLE',
      'Refund overrides apply to a partial return only; this return has no tier adjustment to override.',
      400
    );
  if (isInventoryRestoring && orderId && !isFullReturn) {
    tier = computeLineAdjustments(db, storeId, returnId, orderId, lines, items, overrides);
    partial = allocateThisReturn(db, storeId, returnId, orderId, allocLines, items, tier.total);
    if (partial.returnedLineCount === 0)
      throw new MoneyError(
        'PARTIAL_REFUND_NOTHING_TO_REFUND',
        'This partial return resolves to a zero refund — every claimed line is already covered by an earlier completed return.',
        400
      );
  }
  const walletShare = isGatewayRefund && partial ? partial.walletShare : 0;
  const skipProvider = isGatewayRefund && partial !== null && partial.gatewayShare === 0;

  let walletCreditAmount: number | null = null;
  if (refundMethod === 'store_credit' && isInventoryRestoring && orderId && walletFeature) {
    walletCreditAmount = computeStoreCreditAmount(
      db,
      storeId,
      returnId,
      orderId,
      allocLines,
      items,
      isFullReturn,
      tier.total
    );
    if (!isFullReturn && walletCreditAmount <= 0)
      throw new MoneyError(
        'PARTIAL_REFUND_NOTHING_TO_REFUND',
        'This partial return resolves to a zero refund — every claimed line is already covered by an earlier completed return.',
        400
      );
  }
  return {
    returnId,
    orderId,
    customerId: ret.customer_id as string,
    type,
    isInventoryRestoring,
    isFullReturn,
    isGatewayRefund,
    partial,
    tierLines: tier.lines,
    tierTotal: tier.total,
    allocatedAmount: partial ? partial.cashCredit : null,
    walletCreditAmount,
    walletShare,
    skipProvider,
    items: items.map(i => ({ orderItemId: i.orderItemId, quantity: i.quantity })),
    noRestockItemIds: items.filter(i => i.noRestock).map(i => i.orderItemId),
    outstandingClaims: orderId ? outstandingClaims(db, storeId, orderId, `return:${returnId}`) : [],
  };
}

function overridesOf(v: unknown): Overrides {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v))
    throw new MoneyError('BAD_ARGS', 'refundOverrides', 400);
  const out: Overrides = {};
  for (const [k, o] of Object.entries(v as Record<string, unknown>)) {
    const x = o as { amountMinor?: unknown; reason?: unknown };
    if (typeof x?.amountMinor !== 'number' || typeof x?.reason !== 'string')
      throw new MoneyError('BAD_ARGS', 'refundOverrides', 400);
    out[k] = { amountMinor: x.amountMinor, reason: x.reason };
  }
  return out;
}

export interface ReturnClaimArgs {
  storeId: string;
  returnId: string;
  refundMethod: string;
  refundOverrides?: Overrides;
  /** the platform `customer_wallet` feature, resolved by the caller */
  walletFeature?: boolean;
  now?: number;
}

/** Start of `ReturnService.complete`: status gate, order busy gate, the atomic claim, and the plan. A refusal rolls the claim back. */
export function claimReturn(db: SyncSql, a: ReturnClaimArgs): ReturnPlan {
  const now = a.now ?? Date.now();
  const method = sid(a.refundMethod, 'refundMethod');
  return db.transactionSync(() => {
    const ret = loadReturn(db, a.storeId, sid(a.returnId, 'returnId'));
    if (ret.status !== 'received' && ret.status !== 'inspecting')
      throw new MoneyError('INVALID_STATUS', 'Return must be received before completing', 400);
    if (ret.order_id) assertOrderNotBusy(db, a.storeId, ret.order_id as string, a.returnId);
    if (ret.order_id) assertOrderNotRefunded(db, a.storeId, ret.order_id as string);
    // ATOMIC CLAIM: `refunded_at` null -> now, exactly one caller wins (a double click is a 409, never a second refund)
    if (ret.refunded_at !== null && ret.refunded_at !== undefined)
      throw new MoneyError(
        'RETURN_ALREADY_COMPLETING',
        'This return is already being completed. Refresh before retrying.',
        409
      );
    const plan = planReturn(
      db,
      a.storeId,
      ret,
      method,
      overridesOf(a.refundOverrides),
      a.walletFeature === true
    );
    // #624: what THIS return pays out outside the provider must fit the order's one refundable balance (the provider leg is
    // capped by beginRefund). Early refusal for the merchant; finishReturn re-checks in its own section.
    if (plan.orderId)
      assertRefundable(db, a.storeId, plan.orderId, nonProviderPayout(plan, method, ret));
    db.run(
      `UPDATE returns SET refunded_at = ?1, updated_at = ?1 WHERE id = ?2 AND store_id = ?3 AND refunded_at IS NULL`,
      [now, a.returnId, a.storeId]
    );
    return plan;
  });
}

/** A return cannot pay out again on an order that is already refunded in full (#624). */
function assertOrderNotRefunded(db: SyncSql, storeId: string, orderId: string): void {
  const o = db.all('SELECT status FROM orders WHERE id = ?1 AND store_id = ?2', [
    orderId,
    storeId,
  ])[0];
  if (o?.status === 'refunded')
    throw new MoneyError(
      'ORDER_ALREADY_REFUNDED',
      'This order is already refunded in full, so this return cannot refund the customer again.',
      409
    );
}

/** The money a return completion pays out through the DO itself (store credit, a cash/bank/manual payout, a wallet share). */
function nonProviderPayout(plan: ReturnPlan, method: string, ret: Row): number {
  if (plan.isGatewayRefund) return plan.walletShare;
  if (method === 'store_credit') return plan.walletCreditAmount ?? 0;
  if ((MANUAL_RETURN_METHODS as readonly string[]).includes(method))
    return plan.allocatedAmount ?? num(ret.refund_amount);
  return 0;
}

/** `complete()`'s catch: release the claim, only while the return is still un-completed. */
export function releaseReturn(
  db: SyncSql,
  a: { storeId: string; returnId: string }
): { released: boolean } {
  return {
    released:
      db.run(
        `UPDATE returns SET refunded_at = NULL WHERE id = ?1 AND store_id = ?2 AND status IN ('received', 'inspecting')`,
        [sid(a.returnId, 'returnId'), a.storeId]
      ).changes > 0,
  };
}

export interface ReturnFinishArgs extends ReturnClaimArgs {
  userId: string;
  /** a full gateway completion: the amount the gateway was sent when it was explicit (a remaining balance); absent = keep the estimate */
  gatewayAmount?: number;
  /** PaymentService.refund already ran the whole-order effects itself (its own answer, never re-derived) */
  gatewayRanFullEffects?: boolean;
}

/** End of `ReturnService.complete`: the completion row, tier items, wallet credits and the stock effects, in one section. */
export function finishReturn(
  db: SyncSql,
  a: ReturnFinishArgs
): {
  returnId: string;
  replayed: boolean;
  refundAmount: number;
  tierCarryWaived: number;
  walletCredited: number;
  walletShareCredited: number;
} {
  const now = a.now ?? Date.now();
  const method = sid(a.refundMethod, 'refundMethod');
  return db.transactionSync(() => {
    const ret = loadReturn(db, a.storeId, sid(a.returnId, 'returnId'));
    if (ret.status === 'completed')
      return {
        returnId: a.returnId,
        replayed: true,
        refundAmount: num(ret.refund_amount),
        tierCarryWaived: 0,
        walletCredited: 0,
        walletShareCredited: 0,
      };
    if (ret.status !== 'received' && ret.status !== 'inspecting')
      throw new MoneyError('INVALID_STATUS', 'Return must be received before completing', 400);
    const plan = planReturn(
      db,
      a.storeId,
      ret,
      method,
      overridesOf(a.refundOverrides),
      a.walletFeature === true
    );
    const before = plan.orderId ? refundableBalance(db, a.storeId, plan.orderId) : null;
    // what the customer is owed: the partial allocation, else (full gateway) what the gateway was sent, else the estimate stays
    const refundAmount =
      plan.allocatedAmount ?? (plan.isGatewayRefund ? (a.gatewayAmount ?? null) : null);
    const finalAmount = plan.walletCreditAmount ?? refundAmount ?? num(ret.refund_amount);
    db.run(
      `UPDATE returns SET status = 'completed', refund_method = ?1, refunded_at = ?2, refund_amount = ?3, updated_at = ?2
        WHERE id = ?4 AND store_id = ?5`,
      [method, now, finalAmount, a.returnId, a.storeId]
    );
    // a NON-gateway completion settles any open claim of an earlier gateway attempt (PROVIDER_REFUND_INDETERMINATE recovery)
    if (!plan.isGatewayRefund && plan.orderId)
      reconcileClaims(db, {
        storeId: a.storeId,
        orderId: plan.orderId,
        refundKey: `return:${a.returnId}`,
        refundMethod: method,
        userId: a.userId,
        now,
      });
    // B2B Task 8b: what each item's refund was reduced by (and any override, with who and why)
    for (const l of plan.tierLines)
      db.run(
        `UPDATE return_items SET tier_adjustment = ?1, tier_carry = ?2, adjustment_overridden = ?3,
                adjustment_override_reason = ?4, adjustment_override_by = ?5 WHERE id = ?6`,
        [
          l.adjustment,
          l.carryDelta,
          l.overridden ? 1 : 0,
          l.overrideReason,
          l.overridden ? a.userId : null,
          l.returnItemId,
        ]
      );

    // the stock effects first (the refund ceiling reads the wallet ledger), then the money legs
    if (plan.isInventoryRestoring && plan.orderId && !a.gatewayRanFullEffects) {
      if (plan.isFullReturn)
        reverseOrderEffects(db, { storeId: a.storeId, orderId: plan.orderId, now });
      else {
        refundOrder(db, {
          storeId: a.storeId,
          orderId: plan.orderId,
          lines: plan.items,
          refundKey: a.returnId,
          external: true,
          skipRestock: new Set(plan.noRestockItemIds),
          now,
        });
        // arm THIS return for the stuck-reversal sweep (OrderService.applyRefundEffects' partial arm)
        db.run(
          'UPDATE returns SET reversal_requested_at = ?1, reversal_applied_at = NULL WHERE id = ?2 AND store_id = ?3',
          [now, a.returnId, a.storeId]
        );
      }
    }
    let walletCredited = 0;
    let walletShareCredited = 0;
    if (plan.walletCreditAmount !== null && plan.walletCreditAmount > 0 && plan.orderId) {
      applyWalletEntry(db, {
        storeId: a.storeId,
        customerId: plan.customerId,
        amount: plan.walletCreditAmount,
        type: 'refund_credit',
        idempotencyKey: `return-credit:${a.returnId}`,
        orderId: plan.orderId,
        returnId: a.returnId,
        now,
      });
      walletCredited = plan.walletCreditAmount;
    }
    // the gateway already paid its leg (an external fact, never refused): the wallet share is capped at what is left
    const walletShare =
      plan.walletShare > 0 && plan.orderId
        ? Math.max(
            0,
            Math.min(plan.walletShare, refundableBalance(db, a.storeId, plan.orderId).refundable)
          )
        : 0;
    if (plan.orderId && walletShare < plan.walletShare)
      recordTrimmedCredit(db, {
        storeId: a.storeId,
        orderId: plan.orderId,
        planned: plan.walletShare,
        credited: walletShare,
        source: 'return_wallet_share',
        now,
      });
    if (walletShare > 0 && plan.orderId) {
      applyWalletEntry(db, {
        storeId: a.storeId,
        customerId: plan.customerId,
        amount: walletShare,
        type: 'refund_credit',
        idempotencyKey: `${RETURN_WALLET_SHARE_KEY_PREFIX}${a.returnId}`,
        orderId: plan.orderId,
        returnId: a.returnId,
        now,
      });
      walletShareCredited = walletShare;
    }
    // #624: a store-credit / cash / manual completion must leave refunds <= paid, or the whole section rolls back
    if (!plan.isGatewayRefund && plan.orderId && before)
      assertWithinPaid(db, a.storeId, plan.orderId, before);
    return {
      returnId: a.returnId,
      replayed: false,
      refundAmount: finalAmount,
      tierCarryWaived: plan.tierLines.reduce((n, l) => n + l.carryWaived, 0),
      walletCredited,
      walletShareCredited,
    };
  });
}

// ---------------------------------------------------------------- the GL adjustments

function isGatewayRefundMethod(m: string | null | undefined): boolean {
  return GATEWAY_REFUND_METHODS.includes(m ?? '');
}

/** Where a completed partial return's money went (resolveReturnRefundLegs): read from what the completion committed. */
export function resolveReturnRefundLegs(
  db: SyncSql,
  a: { storeId: string; orderId: string; returnId: string }
): { gateway: number; wallet: number; storeCredit: number } | null {
  const ret = db.all(
    `SELECT refund_method, refund_amount FROM returns WHERE id = ?1 AND store_id = ?2 AND order_id = ?3 AND status = 'completed'`,
    [a.returnId, a.storeId, a.orderId]
  )[0];
  if (!ret) return null;
  const rows = db.all(
    `SELECT amount, idempotency_key FROM wallet_transactions WHERE store_id = ?1 AND return_id = ?2 AND type = 'refund_credit'`,
    [a.storeId, a.returnId]
  );
  const walletFor = (prefix: string) =>
    rows
      .filter(r => String(r.idempotency_key).startsWith(prefix))
      .reduce((s, r) => s + num(r.amount), 0);
  const method = (ret.refund_method as string | null) ?? null;
  const amount = num(ret.refund_amount);
  if (isGatewayRefundMethod(method)) {
    const wallet = walletFor(RETURN_WALLET_SHARE_KEY_PREFIX);
    const gateway = amount - wallet;
    if (gateway < 0 || amount <= 0) return null;
    return { gateway, wallet, storeCredit: 0 };
  }
  if (method === 'store_credit') {
    const wallet = walletFor('return-credit:');
    if (wallet > 0) return { gateway: 0, wallet, storeCredit: 0 };
    if (amount <= 0) return null;
    return { gateway: 0, wallet: 0, storeCredit: amount };
  }
  return null;
}

/**
 * What a single-line backorder cancel gives back (Ruling NZ-FEAT-1), computed INSIDE the cancel's section exactly as the
 * Postgres `cancelBackorder` does inside its transaction: the line's share net of discount plus its tax share, prior reversals
 * (returns, other cancels) counted, this cancel's own marker excluded by key. `notify` = money was taken AND some comes back.
 */
export function backorderCancelAllocation(
  db: SyncSql,
  storeId: string,
  orderId: string,
  refundKey: string,
  requested: Array<{ orderItemId: string; quantity: number }>
): { refundAmount: number; notify: boolean } {
  const order = orderMoney(db, storeId, orderId);
  if (!order) return { refundAmount: 0, notify: false };
  const { prevQty, prevAdjustment } = priorReversed(db, storeId, orderId, refundKey);
  const alloc = allocatePartialReturn({
    subtotal: order.subtotal,
    discount: order.discount,
    tax: order.tax,
    taxIncludedInPrice: order.taxIncludedInPrice,
    lines: orderLines(db, orderId).map(l => ({ ...l, priceSource: l.priceSource })),
    prevQty,
    requested,
    prevAdjustment,
  });
  const paid =
    db.all('SELECT payment_status FROM orders WHERE id = ?1 AND store_id = ?2', [
      orderId,
      storeId,
    ])[0]?.payment_status === 'paid';
  return { refundAmount: alloc.cashCredit, notify: paid && alloc.cashCredit > 0 };
}

export function postPartialReturnJournal(
  db: SyncSql,
  a: {
    storeId: string;
    orderId: string;
    refundKey: string;
    items: Array<{ orderItemId: string; quantity: number }>;
    now?: number;
  }
): { posted: number; skipped?: string } {
  const { storeId, orderId, refundKey } = a;
  sid(orderId, 'orderId');
  sid(refundKey, 'refundKey');
  if (!Array.isArray(a.items)) throw new MoneyError('BAD_ARGS', 'items', 400);
  return db.transactionSync(() => {
    const order = orderMoney(db, storeId, orderId);
    if (!order) return { posted: 0, skipped: 'order-not-found' };
    const lines = orderLines(db, orderId);
    const provider =
      (db.all(
        `SELECT provider FROM payments WHERE order_id = ?1 AND status IN ('completed', 'partially_refunded', 'refunded')
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        [orderId]
      )[0]?.provider as string | undefined) ?? 'cod';
    const baseSourceId = `${orderId}:partial:${refundKey}`;

    if (
      db.all(
        `SELECT id FROM journal_entries WHERE store_id = ?1 AND source = 'order' AND source_id IN (?2, ?3) LIMIT 1`,
        [storeId, baseSourceId, `${baseSourceId}:cogs`]
      )[0]
    )
      return { posted: 0, skipped: 'already-posted' };

    const cashOriginal = db.all(
      `SELECT id, status FROM journal_entries WHERE store_id = ?1 AND source = 'order' AND source_id = ?2`,
      [storeId, orderId]
    )[0];
    if (!cashOriginal) return { posted: 0, skipped: 'no-original-entry' };
    if (cashOriginal.status === 'reversed') return { posted: 0, skipped: 'original-reversed' };
    const cogsOriginal = db.all(
      `SELECT id, status FROM journal_entries WHERE store_id = ?1 AND source = 'order' AND source_id = ?2`,
      [storeId, `${orderId}:cogs`]
    )[0];

    const { prevQty, reasons, prevAdjustment } = priorReversed(db, storeId, orderId, refundKey);
    const returnReason = reasons.get(refundKey) ?? undefined;
    const isBackorderCancel = refundKey.startsWith('backorder:');
    const thisAdjustment = isBackorderCancel
      ? 0
      : num(
          db.all(
            `SELECT COALESCE(SUM(ri.tier_adjustment), 0) AS s FROM return_items ri JOIN returns r ON r.id = ri.return_id
              WHERE ri.return_id = ?1 AND r.store_id = ?2`,
            [refundKey, storeId]
          )[0]?.s
        );
    const alloc = allocatePartialReturn({
      subtotal: order.subtotal,
      discount: order.discount,
      tax: order.tax,
      taxIncludedInPrice: order.taxIncludedInPrice,
      lines: lines.map(l => ({ ...l, priceSource: l.priceSource })),
      prevQty,
      requested: a.items,
      prevAdjustment,
      thisAdjustment,
    });
    const { taxThis, revenueDebit, cashCredit, returnedLines } = alloc;
    if (returnedLines.length === 0) return { posted: 0, skipped: 'nothing-to-adjust' };

    let posted = 0;
    if (cashCredit > 0) {
      // mirror the ORIGINAL sale entry's own cash account (first debit line)
      const originalCashLine = db.all(
        `SELECT account_id FROM journal_lines WHERE entry_id = ?1 AND debit > 0 ORDER BY rowid LIMIT 1`,
        [cashOriginal.id]
      )[0];
      const cashAccountId =
        (originalCashLine?.account_id as string | undefined) ??
        systemAccountId(db, storeId, PROVIDER_TO_CASH_CODE[provider] ?? '1000');
      const revenueAccountId = systemAccountId(db, storeId, '4000');
      const legs = isBackorderCancel
        ? null
        : resolveReturnRefundLegs(db, { storeId, orderId, returnId: refundKey });
      const creditLines: JournalLine[] = [];
      let creditTotal = cashCredit;
      const legLine = (accountId: string, amount: number, lineMemo: string) => {
        if (amount > 0)
          creditLines.push({
            accountId,
            debit: 0,
            credit: amount,
            lineMemo,
            refTable: 'orders',
            refId: order.id,
          });
      };
      if (legs) {
        creditTotal = legs.gateway + legs.wallet + legs.storeCredit;
        legLine(cashAccountId, legs.gateway, `Order ${order.orderNumber} partial refund`);
        if (legs.wallet > 0)
          legLine(
            systemAccountId(db, storeId, '2150'),
            legs.wallet,
            `Order ${order.orderNumber} partial refund to customer wallet`
          );
        if (legs.storeCredit > 0)
          legLine(
            systemAccountId(db, storeId, '2160'),
            legs.storeCredit,
            `Order ${order.orderNumber} partial refund as store credit`
          );
      } else {
        legLine(cashAccountId, cashCredit, `Order ${order.orderNumber} partial refund`);
      }
      const salesReturnDebit = legs ? creditTotal - taxThis : revenueDebit;
      if (salesReturnDebit < 0)
        throw new MoneyError(
          'REFUND_BELOW_TAX_SHARE',
          `postPartialReturnJournal: refund ${refundKey} on order ${orderId} recorded ${creditTotal} piastres, less than its tax share ${taxThis}`,
          409
        );
      const entryLines: JournalLine[] = [];
      if (salesReturnDebit > 0)
        entryLines.push({
          accountId: revenueAccountId,
          debit: salesReturnDebit,
          credit: 0,
          lineMemo: order.discount > 0 ? 'Sales return (net of pro-rata discount)' : 'Sales return',
          refTable: 'orders',
          refId: order.id,
        });
      if (taxThis > 0)
        entryLines.push({
          accountId: systemAccountId(db, storeId, '2100'),
          debit: taxThis,
          credit: 0,
          lineMemo: 'Tax reversed (pro-rata)',
          refTable: 'orders',
          refId: order.id,
        });
      entryLines.push(...creditLines);
      if (creditTotal > 0) {
        postEntry(db, {
          storeId,
          source: 'order',
          sourceId: baseSourceId,
          memo: `${isBackorderCancel ? 'Backorder line cancelled' : 'Partial return'} — Order ${order.orderNumber}${returnReason ? ` (${returnReason})` : ''}`,
          memoAr: isBackorderCancel
            ? `إلغاء بند طلب مسبق — طلب ${order.orderNumber}`
            : `مرتجع جزئي — طلب ${order.orderNumber}`,
          lines: entryLines,
          now: a.now,
        });
        posted += 1;
      }
    }

    // COGS adjustment: only when the sale booked COGS and that entry still stands
    if (cogsOriginal && cogsOriginal.status !== 'reversed') {
      // a line the merchant did not restock never came back into inventory: its COGS stays expensed (written off)
      const notRestocked = new Set(
        db
          .all(`SELECT order_item_id FROM return_items WHERE return_id = ?1 AND condition = ?2`, [
            refundKey,
            NO_RESTOCK_CONDITION,
          ])
          .map(r => r.order_item_id as string)
      );
      const eligible = returnedLines.filter(({ line }) => {
        const full = lines.find(l => l.id === line.id);
        return !!full?.costPrice && full.costPrice > 0 && !notRestocked.has(line.id);
      });
      const cogsLines: JournalLine[] = [];
      let totalCogs = 0;
      if (eligible.length > 0) {
        const inventoryAccountId = systemAccountId(db, storeId, '1200');
        const cogsAccountId = systemAccountId(db, storeId, '5000');
        for (const { line, qty } of eligible) {
          const full = lines.find(l => l.id === line.id)!;
          const itemCogs = full.costPrice! * qty;
          totalCogs += itemCogs;
          cogsLines.push({
            accountId: inventoryAccountId,
            debit: itemCogs,
            credit: 0,
            lineMemo: `Inventory back — ${full.productName} × ${qty}`,
            refTable: 'order_items',
            refId: full.id,
          });
          cogsLines.push({
            accountId: cogsAccountId,
            debit: 0,
            credit: itemCogs,
            lineMemo: `COGS reversed — ${full.productName} × ${qty}`,
            refTable: 'order_items',
            refId: full.id,
          });
        }
      }
      if (totalCogs > 0) {
        postEntry(db, {
          storeId,
          source: 'order',
          sourceId: `${baseSourceId}:cogs`,
          memo: `COGS reversal (partial return) — Order ${order.orderNumber}`,
          memoAr: `عكس تكلفة البضاعة (مرتجع جزئي) — طلب ${order.orderNumber}`,
          lines: cogsLines,
          now: a.now,
        });
        posted += 1;
      }
    }
    return { posted };
  });
}

/** A partial refund made OUTSIDE a return (provider dashboard, "refund via provider" with an amount): DR 4090 / CR the sale's cash account. */
export function postAmountOnlyRefundJournal(
  db: SyncSql,
  a: { storeId: string; orderId: string; refundKey: string; amount: number; now?: number }
): { posted: number; skipped?: string } {
  const { storeId, orderId, refundKey, amount } = a;
  sid(orderId, 'orderId');
  sid(refundKey, 'refundKey');
  if (!Number.isSafeInteger(amount) || amount <= 0) return { posted: 0, skipped: 'invalid-amount' };
  return db.transactionSync(() => {
    const order = orderMoney(db, storeId, orderId);
    if (!order) return { posted: 0, skipped: 'order-not-found' };
    const sourceId = `${orderId}:partial:${refundKey}`;
    if (
      db.all(
        `SELECT id FROM journal_entries WHERE store_id = ?1 AND source = 'order' AND source_id = ?2`,
        [storeId, sourceId]
      )[0]
    )
      return { posted: 0, skipped: 'already-posted' };
    const sale = db.all(
      `SELECT id, status FROM journal_entries WHERE store_id = ?1 AND source = 'order' AND source_id = ?2`,
      [storeId, orderId]
    )[0];
    if (!sale) return { posted: 0, skipped: 'no-original-entry' };
    if (sale.status === 'reversed') return { posted: 0, skipped: 'original-reversed' };
    const cashAccountId = db.all(
      `SELECT account_id FROM journal_lines WHERE entry_id = ?1 AND debit > 0 ORDER BY rowid LIMIT 1`,
      [sale.id]
    )[0]?.account_id as string | undefined;
    if (!cashAccountId)
      throw new MoneyError(
        'SALE_ENTRY_WITHOUT_DEBIT',
        `postAmountOnlyRefundJournal: sale entry for ${orderId} has no debit line`,
        409
      );
    postEntry(db, {
      storeId,
      source: 'order',
      sourceId,
      memo: `Refund outside a return — Order ${order.orderNumber}`,
      memoAr: `استرداد خارج المرتجعات — طلب ${order.orderNumber}`,
      lines: [
        {
          accountId: systemAccountId(db, storeId, '4090'),
          debit: amount,
          credit: 0,
          lineMemo: 'Revenue refunded (no goods returned)',
          refTable: 'orders',
          refId: order.id,
        },
        {
          accountId: cashAccountId,
          debit: 0,
          credit: amount,
          lineMemo: `Order ${order.orderNumber} refund ${refundKey.slice('refund:'.length)}`,
          refTable: 'orders',
          refId: order.id,
        },
      ],
      now: a.now,
    });
    return { posted: 1 };
  });
}

// ---------------------------------------------------------------- admin refund quote (STORE-QA-76)

export interface OrderRefundQuote {
  orderId: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  currency: string;
  customerId: string | null;
  total: number;
  paid: number;
  refunded: number;
  /** the ONE refundable balance across every channel (#624), never below 0 */
  refundable: number;
  /** the provider of the newest captured payment (null: COD / unpaid), so the admin offers only the methods that can work */
  paymentProvider: string | null;
  /** can a return be opened for this order right now (delivered; a guest order is fine, GUEST-RET-1)? `reason` says why not */
  returnable: { ok: true } | { ok: false; reason: 'NOT_DELIVERED' | 'GUEST_ORDER' };
  lines: Array<{
    orderItemId: string;
    productId: string;
    name: string;
    unitPrice: number;
    quantity: number;
    /** units still open to a return: ordered - claimed by a live return - backorder cancels */
    remaining: number;
    trackInventory: boolean;
    bundleGroupId: string | null;
  }>;
  /** only when `items` was asked: what completing those lines would pay back (piastres), capped at `refundable` */
  estimate: number | null;
  /** only when `items` was asked: they cover every line, so the whole-order path (and its restock-everything rule) applies */
  coversWholeOrder: boolean;
}

/**
 * Read-only: what the admin refund / new-return dialogs show before anything moves. The figures come from the same helpers
 * the writers use (`refundableBalance`, the claimed-quantity rule of `createReturn`, `allocatePartialReturn`), so the number
 * shown is the number the server enforces.
 */
export function quoteOrderRefund(
  db: SyncSql,
  a: { storeId: string; orderId: string; items?: Array<{ orderItemId: string; quantity: number }> }
): OrderRefundQuote {
  const storeId = sid(a.storeId, 'storeId');
  const orderId = sid(a.orderId, 'orderId');
  const order = orderMoney(db, storeId, orderId);
  if (!order) throw new MoneyError('ORDER_NOT_FOUND', 'order not found', 404);
  const head = db.all(
    'SELECT payment_status, currency FROM orders WHERE id = ?1 AND store_id = ?2',
    [orderId, storeId]
  )[0];
  const paymentStatus = String(head?.payment_status ?? '');
  const bal = refundableBalance(db, storeId, orderId);
  const lines = orderLines(db, orderId);
  const claimed = backorderCancelled(db, storeId, orderId).qty;
  for (const r of db.all(
    `SELECT ri.order_item_id, ri.quantity FROM return_items ri JOIN returns r ON r.id = ri.return_id
      WHERE r.store_id = ?1 AND r.order_id = ?2 AND r.status NOT IN ('rejected', 'cancelled')`,
    [storeId, orderId]
  ))
    claimed.set(
      r.order_item_id as string,
      (claimed.get(r.order_item_id as string) ?? 0) + num(r.quantity)
    );
  const tracked = new Set(
    db
      .all('SELECT id FROM products WHERE store_id = ?1 AND track_inventory = 1', [storeId])
      .map(r => r.id as string)
  );
  const provider =
    (db.all(
      `SELECT provider FROM payments WHERE order_id = ?1 AND status IN ('completed', 'partially_refunded', 'refunded')
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [orderId]
    )[0]?.provider as string | undefined) ?? null;

  let estimate: number | null = null;
  let coversWholeOrder = false;
  if (a.items !== undefined) {
    const want = new Map<string, number>();
    for (const i of a.items) {
      if (!Number.isInteger(i.quantity) || i.quantity < 1)
        throw new MoneyError('INVALID_QUANTITY', 'Quantity must be at least 1', 400);
      want.set(i.orderItemId, (want.get(i.orderItemId) ?? 0) + i.quantity);
    }
    for (const [lineId, q] of want) {
      const line = lines.find(l => l.id === lineId);
      if (!line) throw new MoneyError('INVALID_ITEM', `Order item ${lineId} not found`, 400);
      if (q + (claimed.get(lineId) ?? 0) > line.quantity)
        throw new MoneyError(
          'INVALID_QUANTITY',
          'Quantity exceeds remaining returnable quantity for this item',
          400
        );
    }
    coversWholeOrder = lines.length > 0 && lines.every(l => (want.get(l.id) ?? 0) >= l.quantity);
    if (coversWholeOrder) estimate = Math.max(0, bal.refundable);
    else {
      const { prevQty, prevAdjustment } = priorReversed(db, storeId, orderId);
      const alloc = allocatePartialReturn({
        subtotal: order.subtotal,
        discount: order.discount,
        tax: order.tax,
        taxIncludedInPrice: order.taxIncludedInPrice,
        lines: lines.map(l => ({
          id: l.id,
          quantity: l.quantity,
          price: l.price,
          priceSource: l.priceSource,
        })),
        prevQty,
        requested: [...want].map(([orderItemId, quantity]) => ({ orderItemId, quantity })),
        prevAdjustment,
        thisAdjustment: 0,
      });
      estimate = Math.min(alloc.cashCredit, Math.max(0, bal.refundable));
    }
  }
  return {
    orderId,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus,
    currency: String(head?.currency ?? 'EGP'),
    customerId: order.customerId,
    total: order.total,
    paid: bal.paid,
    refunded: bal.refunded,
    refundable: Math.max(0, bal.refundable),
    paymentProvider: provider,
    returnable:
      order.status !== 'delivered' ? { ok: false, reason: 'NOT_DELIVERED' } : { ok: true },
    lines: lines.map(l => ({
      orderItemId: l.id,
      productId: l.productId,
      name: l.productName,
      unitPrice: l.price,
      quantity: l.quantity,
      remaining: Math.max(0, l.quantity - (claimed.get(l.id) ?? 0)),
      trackInventory: tracked.has(l.productId),
      bundleGroupId: l.bundleGroupId,
    })),
    estimate,
    coversWholeOrder,
  };
}
