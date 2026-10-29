import { runKeyed, ensureKeyedSchema } from './keyed-op';
import {
  earnPointsFromPurchase,
  reverseEarnedPointsFromOrder,
  reverseRedeemedPointsFromOrder,
} from './loyalty';
import { placeOrder, quoteOrder, type CheckoutInput } from './checkout';
import { cancelOrder, refundOrder } from './refund';
import {
  applyPaymentEventSync,
  beginRefund,
  completeRefund,
  confirmInstapay,
  createPayment,
  expireInstapay,
  markRefundIndeterminate,
  releaseRefund,
  type ConfirmedTransaction,
  type PaymentWebhookInput,
} from './payments';
import { cancelSaleDocument, issueRefundDocument } from './fiscal';
import { changeOrderStatus } from './order-status';
import { postOrderSaleJournal, postRefundJournal } from './ledger';
import {
  applyGoldRates,
  decidePendingGoldRate,
  repriceGoldProduct,
  updateGoldSettings,
  type ApplyRatesInput,
  type GoldSettingsInput,
} from './gold-rates';
import {
  bulkSwitchGoldMode,
  createGoldVariant,
  type NewVariant,
  setGoldProductPricing,
  type ProductPricingInput,
  type VariantPricingInput,
} from './gold-pricing';
import { placeAdminOrder, type AdminOrderInput } from './admin-order';
import { searchOrderIds } from './order-search';
import { MoneyError, type SyncSql } from './sync-sql';

/**
 * Money operations on the StoreDO (INFRA-CF-1 PR D2b, Ruling CF-MONEY-1; plan section 4 row-lock inventory).
 *
 * The same shape as the stock operations (CF-STOCK-1): ONE named operation = ONE `transactionSync` section (the Durable
 * Object's single thread replaces the Postgres `FOR UPDATE`), an optional idempotency key stored as a marker row INSIDE
 * that section (`_money_ops`), a refusal is an answer. The engine functions (`do/loyalty.ts` ...) already carry the money
 * rules and their own in-data idempotency (unique ledger rows); this registry is the ONLY door to them from outside the DO.
 *
 * EXTERNAL MONEY FACTS ARE RECORDED, NEVER REJECTED (memory feedback-never-reject-an-external-money-fact): an operation
 * here applies a fact the platform already decided (an order delivered, a refund settled). Where the Postgres service
 * floors or clamps a figure (a reversal cannot take a customer below zero points) the operation clamps the same way and
 * still records the row; it never refuses the fact.
 */
export type MoneyOpName =
  | 'loyaltyEarn'
  | 'loyaltyReverseEarned'
  | 'loyaltyReverseRedeemed'
  | 'createOrder'
  | 'confirmPayment'
  | 'cancel'
  | 'expireHold'
  | 'paymentCreate'
  | 'paymentWebhook'
  | 'refundBegin'
  | 'refundComplete'
  | 'refundRelease'
  | 'refundIndeterminate'
  | 'refundBook'
  | 'journalSale'
  | 'journalRefund'
  | 'goldApplyRates'
  | 'goldDecidePending'
  | 'goldUpdateSettings'
  | 'goldRepriceProduct'
  | 'goldSetProductPricing'
  | 'goldBulkSwitchMode'
  | 'goldCreateVariant'
  | 'fanoutDisarm'
  | 'orderStatus'
  | 'quoteOrder'
  | 'fiscalRefund'
  | 'fiscalCancelSale'
  | 'searchOrders'
  | 'createAdminOrder'
  | 'recoveryCoupon';
export const MONEY_OP_NAMES: readonly MoneyOpName[] = [
  'loyaltyEarn',
  'loyaltyReverseEarned',
  'loyaltyReverseRedeemed',
  'createOrder',
  'confirmPayment',
  'cancel',
  'expireHold',
  'paymentCreate',
  'paymentWebhook',
  'refundBegin',
  'refundComplete',
  'refundRelease',
  'refundIndeterminate',
  'refundBook',
  'journalSale',
  'journalRefund',
  'goldApplyRates',
  'goldDecidePending',
  'goldUpdateSettings',
  'goldRepriceProduct',
  'goldSetProductPricing',
  'goldBulkSwitchMode',
  'goldCreateVariant',
  'fanoutDisarm',
  'orderStatus',
  'quoteOrder',
  'fiscalRefund',
  'fiscalCancelSale',
  'searchOrders',
  'createAdminOrder',
  'recoveryCoupon',
];

const TABLE = '_money_ops';
export const ensureMoneyOpsSchema = (db: SyncSql): void => {
  ensureKeyedSchema(db, TABLE);
};

const id = (v: unknown, what: string): string =>
  typeof v === 'string' && v.length > 0 && v.length <= 128
    ? v
    : (() => {
        throw new MoneyError('BAD_ARGS', what, 400);
      })();

type Args = Record<string, unknown>;
const OPS: Record<MoneyOpName, (db: SyncSql, storeId: string, a: Args) => unknown> = {
  /** LoyaltyService.earnPointsFromPurchase: `featureEnabled` is the platform `loyalty` flag, resolved by the caller. */
  loyaltyEarn: (db, storeId, a) =>
    earnPointsFromPurchase(db, {
      storeId,
      customerId: id(a.customerId, 'customerId'),
      orderId: id(a.orderId, 'orderId'),
      featureEnabled: a.featureEnabled === true,
    }),
  loyaltyReverseEarned: (db, storeId, a) =>
    reverseEarnedPointsFromOrder(db, { storeId, orderId: id(a.orderId, 'orderId') }),
  loyaltyReverseRedeemed: (db, storeId, a) =>
    reverseRedeemedPointsFromOrder(db, { storeId, orderId: id(a.orderId, 'orderId') }),
  /**
   * OrderService.create (Ruling CF-ORDERS-1): stock reserve, hold cap, coupon limit, loyalty redeem, wallet debit and the
   * order rows are ONE section. The caller never supplies `storeId` (bound by the DO) nor `now` (the DO clock).
   */
  createOrder: (db, storeId, a) => {
    const {
      storeId: _s,
      now: _n,
      locale,
      smsOptIn,
      source,
      orderNotes,
      ...rest
    } = a as Partial<CheckoutInput> & {
      locale?: string;
      smsOptIn?: boolean;
      source?: string;
      orderNotes?: string;
    };
    const placed = placeOrder(db, { ...(rest as CheckoutInput), storeId });
    // the columns the order service stamps that the pricing engine does not own (Postgres parity: notes, locale, sms opt-in, source)
    if (!placed.replayed)
      db.run(
        'UPDATE orders SET locale = ?, sms_opt_in = ?, source = ?, notes = ? WHERE id = ? AND store_id = ?',
        [
          typeof locale === 'string' ? locale : null,
          smsOptIn === true ? 1 : 0,
          typeof source === 'string' && source.length > 0 && source.length <= 32 ? source : 'web',
          typeof orderNotes === 'string' ? orderNotes : null,
          placed.orderId,
          storeId,
        ]
      );
    return placed;
  },
  /** The merchant confirms an InstaPay transfer (OrderService/instapay-confirmation): exactly once. */
  confirmPayment: (db, storeId, a) =>
    confirmInstapay(db, {
      storeId,
      orderId: id(a.orderId, 'orderId'),
      actorUserId: typeof a.actorUserId === 'string' ? a.actorUserId : null,
      proofSubmitted: a.proofSubmitted === true,
    }),
  /** updateStatus -> cancelled: status plus the whole reversal (stock, coupon, loyalty, wallet, backorders). */
  cancel: (db, storeId, a) => {
    const orderId = id(a.orderId, 'orderId');
    const r = cancelOrder(db, {
      storeId,
      orderId,
      restoreInventory: a.restoreInventory !== false,
    });
    // rollbackForPaymentFailure's paper trail: appended to the order notes in the same section
    if (!r.replayed && typeof a.note === 'string' && a.note.length > 0 && a.note.length <= 500)
      db.run(
        "UPDATE orders SET notes = CASE WHEN notes IS NULL OR notes = '' THEN ?1 ELSE notes || char(10) || ?1 END WHERE id = ?2 AND store_id = ?3",
        [a.note, orderId, storeId]
      );
    return r;
  },
  /** An unconfirmed InstaPay hold whose window ran out is cancelled; 'skipped' when it is not (or no longer) expirable. */
  expireHold: (db, storeId, a) =>
    expireInstapay(db, {
      storeId,
      orderId: id(a.orderId, 'orderId'),
      proofSubmitted: a.proofSubmitted === true,
    }),
  /** Payment row of an order (PaymentService.recordCreatedPayment); amount must equal the order total. */
  paymentCreate: (db, storeId, a) =>
    createPayment(db, {
      storeId,
      orderId: id(a.orderId, 'orderId'),
      provider: id(a.provider, 'provider'),
      method: typeof a.method === 'string' ? a.method : null,
      amount: a.amount as number,
      currency: typeof a.currency === 'string' ? a.currency : undefined,
      transactionId: typeof a.transactionId === 'string' ? a.transactionId : null,
      invoiceId: typeof a.invoiceId === 'string' ? a.invoiceId : null,
      paymentUrl: typeof a.paymentUrl === 'string' ? a.paymentUrl : null,
    }),
  /**
   * A signed provider delivery (Paymob, Kashier, Fawry). The gateway confirmation (Kashier) is fetched by the Worker
   * OUTSIDE the DO and handed in as `confirmed`; a provider that needs it and has none is refused 503, nothing written.
   * The idempotency is in the data (`payment_event_log (provider, event_id)`), so a replay applies once with or without a key.
   */
  paymentWebhook: (db, storeId, a) =>
    applyPaymentEventSync(
      db,
      { ...(a.input as PaymentWebhookInput), storeId, now: undefined },
      (a.confirmed as ConfirmedTransaction | null | undefined) ?? null
    ),
  refundBegin: (db, storeId, a) =>
    beginRefund(db, {
      storeId,
      paymentId: id(a.paymentId, 'paymentId'),
      amount: typeof a.amount === 'number' ? a.amount : undefined,
      refundKey: typeof a.refundKey === 'string' ? a.refundKey : undefined,
      reason: typeof a.reason === 'string' ? a.reason : undefined,
      itemLevel: a.itemLevel === true,
    }),
  refundComplete: (db, storeId, a) =>
    completeRefund(db, {
      storeId,
      claimId: id(a.claimId, 'claimId'),
      refundId: id(a.refundId, 'refundId'),
      providerStatus: typeof a.providerStatus === 'string' ? a.providerStatus : undefined,
      reason: typeof a.reason === 'string' ? a.reason : undefined,
    }),
  refundRelease: (db, storeId, a) =>
    releaseRefund(db, {
      storeId,
      claimId: id(a.claimId, 'claimId'),
      reason: id(a.reason, 'reason'),
      error: typeof a.error === 'string' ? a.error : undefined,
    }),
  refundIndeterminate: (db, storeId, a) => {
    markRefundIndeterminate(db, {
      storeId,
      claimId: id(a.claimId, 'claimId'),
      error: typeof a.error === 'string' ? a.error : 'unknown',
    });
    return { ok: true };
  },
  /** Full refund (`neither lines nor amount`) or a partial / store-credit refund (`refundKey` required): see `refundOrder`. */
  refundBook: (db, storeId, a) =>
    refundOrder(db, {
      storeId,
      orderId: id(a.orderId, 'orderId'),
      amount: typeof a.amount === 'number' ? a.amount : undefined,
      lines: Array.isArray(a.lines)
        ? (a.lines as { orderItemId: string; quantity: number }[])
        : undefined,
      refundKey: typeof a.refundKey === 'string' ? a.refundKey : undefined,
      walletCredit: typeof a.walletCredit === 'number' ? a.walletCredit : undefined,
      external: a.external === true,
      keepPaymentStatus: a.keepPaymentStatus === true,
    }),
  journalSale: (db, storeId, a) =>
    postOrderSaleJournal(db, { storeId, orderId: id(a.orderId, 'orderId') }),
  journalRefund: (db, storeId, a) =>
    postRefundJournal(db, {
      storeId,
      orderId: id(a.orderId, 'orderId'),
      reason: typeof a.reason === 'string' ? a.reason : undefined,
    }),
  goldApplyRates: (db, storeId, a) =>
    applyGoldRates(
      db,
      storeId,
      a.input as ApplyRatesInput,
      a.feed
        ? { feed: a.feed as Record<string, unknown>, forcePending: a.forcePending === true }
        : { userId: id(a.userId, 'userId') }
    ),
  goldDecidePending: (db, storeId, a) =>
    decidePendingGoldRate(
      db,
      storeId,
      id(a.rateId, 'rateId'),
      a.decision === 'reject' ? 'reject' : 'confirm',
      { userId: id(a.userId, 'userId') }
    ),
  goldUpdateSettings: (db, storeId, a) =>
    updateGoldSettings(db, storeId, a.input as GoldSettingsInput, {
      userId: id(a.userId, 'userId'),
    }),
  /** The stuck status-fanout sweep gives up on a transition a later status superseded: conditional, so a claimed one is left alone. */
  fanoutDisarm: (db, storeId, a) => ({
    disarmed:
      db.run(
        'UPDATE orders SET status_fanout_requested_at = NULL WHERE id = ? AND store_id = ? AND status_fanout_claimed_at IS NULL AND status_fanout_requested_at = ?',
        [id(a.orderId, 'orderId'), storeId, a.requestedAt as number]
      ).changes > 0,
  }),
  /** OrderService.quote (dryRun): the totals and per-line prices of a cart, nothing reserved, nothing written. */
  quoteOrder: (db, storeId, a) => {
    const { storeId: _s, now: _n, ...rest } = a as Partial<CheckoutInput>;
    return quoteOrder(db, { ...(rest as CheckoutInput), storeId });
  },
  /** The plain status transitions (confirmed, processing, shipped, delivered): see `changeOrderStatus`. */
  orderStatus: (db, storeId, a) =>
    changeOrderStatus(db, {
      storeId,
      orderId: id(a.orderId, 'orderId'),
      status: typeof a.status === 'string' ? a.status : '',
    }),
  /** GoldRateService.setProductPricing (Ruling CF-LAST-1): spec, variant overrides and the re-price are ONE section. */
  goldSetProductPricing: (db, storeId, a) =>
    setGoldProductPricing(db, storeId, id(a.productId, 'productId'), {
      product: a.product as ProductPricingInput,
      variants: a.variants as VariantPricingInput[] | undefined,
    }),
  goldBulkSwitchMode: (db, storeId, a) =>
    bulkSwitchGoldMode(db, storeId, a.ids as string[], a.mode as 'fixed' | 'gold_rate'),
  /** The variant INSERT of GoldRateService.asRepricer, born priced, in one section (rolls back when a rate is missing). */
  goldCreateVariant: (db, storeId, a) =>
    createGoldVariant(
      db,
      storeId,
      id(a.productId, 'productId'),
      a.variant as NewVariant,
      (a.optionValueIds as string[] | undefined) ?? []
    ),
  /** The credit note / refund receipt of a refund event (order-refunded fanout), keyed per refund: see `issueRefundDocument`. */
  fiscalRefund: (db, storeId, a) => ({
    document: issueRefundDocument(db, {
      storeId,
      orderId: id(a.orderId, 'orderId'),
      refundRef: id(a.refundRef, 'refundRef'),
      amount: a.amount === 'remaining' ? 'remaining' : typeof a.amount === 'number' ? a.amount : 0,
      reason: typeof a.reason === 'string' ? a.reason : null,
      now: Date.now(),
    }),
  }),
  /** A sale cancelled before any money was taken keeps its number, marked cancelled (MONEYB-1). */
  fiscalCancelSale: (db, storeId, a) => ({
    document: cancelSaleDocument(db, {
      storeId,
      orderId: id(a.orderId, 'orderId'),
      now: Date.now(),
    }),
  }),
  /** The admin order-list search (Ruling CF-R4-1): the id sets of the order-number, registered-customer and guest-contact arms. A read; a retry is a fresh read. */
  searchOrders: (db, storeId, a) =>
    searchOrderIds(
      db,
      storeId,
      typeof a.search === 'string' ? a.search : '',
      typeof a.numberLimit === 'number' && a.numberLimit > 0 ? a.numberLimit : undefined
    ),
  /** A merchant's manual order (Ruling CF-R4-2): priced from the DO's rows, no stock reserved, overrides recorded in the section. */
  createAdminOrder: (db, storeId, a) => {
    const { storeId: _s, now: _n, ...rest } = a as Partial<AdminOrderInput>;
    return placeAdminOrder(db, { ...(rest as AdminOrderInput), storeId });
  },
  /**
   * The abandoned-cart step-3 recovery coupon (Ruling CF-R4-5): created once per cart (the code is derived from the cart),
   * re-activated with a fresh expiry when it already exists, and linked to the cart, in ONE section. The upsert and the link
   * are two Postgres statements; here a crash between them cannot leave an unlinked coupon.
   */
  recoveryCoupon: (db, storeId, a) => {
    const abandonedCartId = id(a.abandonedCartId, 'abandonedCartId');
    const code = id(a.code, 'code');
    const percent = a.percent;
    if (typeof percent !== 'number' || !Number.isInteger(percent) || percent < 0 || percent > 100)
      throw new MoneyError('BAD_ARGS', 'percent', 400);
    const expiresAt = a.expiresAt;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))
      throw new MoneyError('BAD_ARGS', 'expiresAt', 400);
    const maxDiscount = typeof a.maxDiscount === 'number' ? a.maxDiscount : null;
    return db.transactionSync(() => {
      const cart = db.all('SELECT id FROM abandoned_carts WHERE id = ? AND store_id = ?', [
        abandonedCartId,
        storeId,
      ])[0];
      if (!cart) throw new MoneyError('NOT_FOUND', 'abandoned cart not found', 404);
      const existing = db.all('SELECT id FROM coupons WHERE store_id = ? AND code = ?', [
        storeId,
        code,
      ])[0];
      let couponId: string;
      if (existing) {
        couponId = existing.id as string;
        db.run('UPDATE coupons SET expires_at = ?, is_active = 1, updated_at = ? WHERE id = ?', [
          expiresAt,
          Date.now(),
          couponId,
        ]);
      } else {
        couponId = crypto.randomUUID();
        db.run(
          "INSERT INTO coupons (id, store_id, code, name, type, value, max_discount, usage_limit, usage_limit_per_user, expires_at, is_active, scope_product_ids, scope_category_ids) VALUES (?, ?, ?, 'Cart Recovery Coupon', 'percentage', ?, ?, 1, 1, ?, 1, '[]', '[]')",
          [couponId, storeId, code, percent, maxDiscount, expiresAt]
        );
      }
      db.run('UPDATE abandoned_carts SET coupon_id = ? WHERE id = ? AND store_id = ?', [
        couponId,
        abandonedCartId,
        storeId,
      ]);
      return { couponId, created: !existing };
    });
  },
  goldRepriceProduct: (db, storeId, a) => ({
    repriced: repriceGoldProduct(db, storeId, id(a.productId, 'productId')),
  }),
};

/** Run one money operation for `storeId`. THROWS `MoneyError` for a refusal; everything it wrote is rolled back with it. */
export function runMoneyOp(
  db: SyncSql,
  storeId: string,
  op: string,
  args: unknown,
  key?: string,
  now: () => number = Date.now
): unknown {
  if (!Object.prototype.hasOwnProperty.call(OPS, op))
    throw new MoneyError('MONEY_OP_NOT_ALLOWED', `money operation ${op}`, 400);
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new MoneyError('BAD_ARGS', 'args', 400);
  return runKeyed(db, TABLE, op, args, key, now, () =>
    OPS[op as MoneyOpName](db, storeId, args as Args)
  );
}
