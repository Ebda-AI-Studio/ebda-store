/**
 * STORE-QA-74 / Ruling REVENUE-CACHE-1: every money write that can change a counted sale drops the cached revenue figures
 * (analytics dashboard payload = finance "Net sales" + KPIs, customers spend strip). Driver: the money-op classification over the
 * REAL op list of the Durable Object (`MONEY_OP_NAMES`) and the invalidator over a stubbed public-cache. The end-to-end proof
 * (refund -> NEXT read, on a real Durable Object store) is `apps/api/workers-test/merchant-orders-do.test.ts` "STORE-QA-74".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MONEY_OP_NAMES } from '../../packages/repo/src/do/money-ops';

const h = vi.hoisted(() => ({ prefix: vi.fn(), customers: vi.fn() }));
vi.mock('@api/lib/public-cache', () => ({
  invalidateCachedPrefix: h.prefix,
  invalidateCustomersCache: h.customers,
}));
vi.mock('@api/lib/logger', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import {
  analyticsDashboardPrefix,
  invalidateStoreRevenueCaches,
  moneyOpMayChangeRevenue,
} from '@api/lib/revenue-cache';

beforeEach(() => {
  h.prefix.mockReset().mockResolvedValue(undefined);
  h.customers.mockReset().mockResolvedValue(undefined);
});

describe('moneyOpMayChangeRevenue: classification over the real op list', () => {
  const mustInvalidate = [
    'confirmPayment',
    'cancel',
    'orderStatus',
    'paymentWebhook',
    'refundBegin',
    'refundComplete',
    'refundBook',
    'instapayRefundRecord',
    'manualRefundRecord',
    'returnFinish',
    'returnCreate',
    'codMarkPaid',
    'createAdminOrder',
    'backorderCancel',
    'journalRefund',
  ];
  it.each(mustInvalidate)('%s is a revenue write and is registered as a money op', op => {
    expect(MONEY_OP_NAMES).toContain(op);
    expect(moneyOpMayChangeRevenue(op)).toBe(true);
  });

  it('reads never invalidate', () => {
    for (const op of [
      'analyticsPeriod',
      'analyticsNetRevenue',
      'searchOrders',
      'trialBalance',
      'stockValue',
    ])
      expect(moneyOpMayChangeRevenue(op)).toBe(false);
  });

  it('the guest checkout hot path is the one documented bounded-stale write', () => {
    expect(moneyOpMayChangeRevenue('createOrder')).toBe(false);
  });

  it('every op that is neither a read nor createOrder invalidates (a new write op is covered by default)', () => {
    const silent = MONEY_OP_NAMES.filter(op => !moneyOpMayChangeRevenue(op));
    // the ONLY silent ops are reads and the documented createOrder: a new op name must not slip into this list unreviewed
    for (const op of silent)
      expect(
        /^(analytics|search|loyalty(CustomerPoints|History|Members|Stats|StoreTransactions|ImportState)$|receipt(Get|List)$|trialBalance$|periodGlCredits$|accountTotals$|stockValue$|quoteOrder$|paymentIndexCheck$|createOrder$)/.test(
          op
        ),
        op
      ).toBe(true);
  });
});

describe('invalidateStoreRevenueCaches', () => {
  it("drops the store's analytics dashboard prefix AND the customers snapshot", async () => {
    await invalidateStoreRevenueCaches('s1');
    expect(h.prefix).toHaveBeenCalledWith(analyticsDashboardPrefix('s1'));
    expect(analyticsDashboardPrefix('s1')).toBe('analytics:dashboard:s1:');
    expect(h.customers).toHaveBeenCalledWith('s1');
  });

  it('never throws: a Redis outage must not fail the write that already committed', async () => {
    h.prefix.mockRejectedValue(new Error('redis down'));
    await expect(invalidateStoreRevenueCaches('s1')).resolves.toBeUndefined();
    expect(h.customers).toHaveBeenCalled();
  });
});
