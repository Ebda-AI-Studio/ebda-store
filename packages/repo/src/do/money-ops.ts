import { runKeyed, ensureKeyedSchema } from './keyed-op';
import {
  earnPointsFromPurchase,
  reverseEarnedPointsFromOrder,
  reverseRedeemedPointsFromOrder,
} from './loyalty';
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
export type MoneyOpName = 'loyaltyEarn' | 'loyaltyReverseEarned' | 'loyaltyReverseRedeemed';
export const MONEY_OP_NAMES: readonly MoneyOpName[] = [
  'loyaltyEarn',
  'loyaltyReverseEarned',
  'loyaltyReverseRedeemed',
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
