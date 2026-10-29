import { runKeyed, ensureKeyedSchema } from './keyed-op';
import {
  earnPointsFromPurchase,
  reverseEarnedPointsFromOrder,
  reverseRedeemedPointsFromOrder,
} from './loyalty';
import { placeOrder, type CheckoutInput } from './checkout';
import { cancelOrder } from './refund';
import { confirmInstapay, expireInstapay } from './payments';
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
  | 'expireHold';
export const MONEY_OP_NAMES: readonly MoneyOpName[] = [
  'loyaltyEarn',
  'loyaltyReverseEarned',
  'loyaltyReverseRedeemed',
  'createOrder',
  'confirmPayment',
  'cancel',
  'expireHold',
];

const TABLE = '_money_ops';
export const ensureMoneyOpsSchema = (db: SyncSql): void => ensureKeyedSchema(db, TABLE);

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
  cancel: (db, storeId, a) =>
    cancelOrder(db, {
      storeId,
      orderId: id(a.orderId, 'orderId'),
      restoreInventory: a.restoreInventory !== false,
    }),
  /** An unconfirmed InstaPay hold whose window ran out is cancelled; 'skipped' when it is not (or no longer) expirable. */
  expireHold: (db, storeId, a) =>
    expireInstapay(db, {
      storeId,
      orderId: id(a.orderId, 'orderId'),
      proofSubmitted: a.proofSubmitted === true,
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
