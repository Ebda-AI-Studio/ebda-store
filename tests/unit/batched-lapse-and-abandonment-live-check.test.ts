/**
 * Security review of #723 (batched feature lookups), two MEDIUM findings.
 *  1. The row-based `automationFlagsFromRows` (FeatureService's batched prefetch) treated only `canceled` as lapsed, while
 *     `getEntitlements` also downgrades a lapsed InstaPay row (`past_due`, instapay, no retry date, #836): a lapsed manual-pay
 *     store kept paid automation flags in batched sweeps. Both now go through ONE function, `effectivePlanCode` (internal to plan-entitlements).
 *  2. payment-abandonment-sweep used the batched, possibly stale `selectEnabled` as its ONLY gate. It still narrows with it, but
 *     re-checks `isFeatureEnabled` live per store right before it stamps.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';

const h = vi.hoisted(() => ({
  selectEnabled: vi.fn(),
  isFeatureEnabled: vi.fn(),
  abandonStamp: vi.fn(),
  candidates: [] as unknown[],
}));
vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { createFunction: (_c: unknown, fn: unknown) => fn, send: vi.fn() },
}));
vi.mock('../../apps/api/src/services/feature.service', () => ({
  featureService: { selectEnabled: h.selectEnabled, isFeatureEnabled: h.isFeatureEnabled },
}));
vi.mock('../../apps/api/src/lib/jobs/store-db', () => ({
  sweepStoresDb: async () => h.candidates,
  storeNameOf: async (id: string) => id,
}));
vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeMoney: async () => ({ abandonStamp: h.abandonStamp }),
}));
vi.mock('../../apps/api/src/services/onesignal.service', () => ({
  OneSignalService: { notifyAdminsOfAbandonedCheckout: vi.fn() },
}));

import { automationFlagsFromRows } from '../../apps/api/src/services/plan-entitlements';
import { paymentAbandonmentSweep } from '../../apps/api/src/lib/inngest/functions/payment-abandonment-sweep';

const planRows = new Map(
  DEFAULT_PLAN_SEEDS.map(p => [
    p.code,
    { code: p.code, limits: p.limits, featureTier: p.featureTier },
  ])
);
const paidCode = DEFAULT_PLAN_SEEDS.find(
  p => p.limits.abandonedCartAutomation === true && p.code !== 'free'
)!.code;

describe('batched row path agrees with getEntitlements on a lapsed manual subscription', () => {
  const sub = (over: Record<string, unknown> = {}) => ({
    planCode: paidCode,
    status: 'active',
    billingMethod: 'instapay',
    nextRetryAt: null as Date | null,
    ...over,
  });

  it('a lapsed InstaPay row (past_due, no retry date) is entitled to the free plan: no paid automation flags', () => {
    const lapsed = automationFlagsFromRows('free', sub({ status: 'past_due' }), planRows);
    expect(lapsed.effectiveCode).toBe('free');
    expect(lapsed.flags.abandonedCartAutomation).toBe(false);
    expect(lapsed.flags.whatsappAutomation).toBe(false);
    const paid = automationFlagsFromRows('free', sub(), planRows);
    expect(paid.effectiveCode).toBe(paidCode);
    expect(paid.flags.abandonedCartAutomation).toBe(true);
  });

  it('a card row in dunning, an InstaPay row still inside its grace (retry date set) and an active row keep the paid plan', () => {
    for (const s of [
      sub({ status: 'past_due', billingMethod: 'card' }),
      sub({ status: 'past_due', nextRetryAt: new Date(Date.now() + 86_400_000) }),
      sub({ status: 'trialing' }),
    ])
      expect(automationFlagsFromRows('free', s, planRows).effectiveCode).toBe(paidCode);
  });

  it('canceled still falls back to free, and no row derives the plan from stores.plan', () => {
    expect(
      automationFlagsFromRows('free', sub({ status: 'canceled' }), planRows).effectiveCode
    ).toBe('free');
    expect(automationFlagsFromRows('free', null, planRows).effectiveCode).toBe('free');
  });
});

const step = { run: async <T>(_id: string, fn: () => Promise<T>) => fn() };
const STORE = '11111111-1111-4111-8111-111111111111';
const order = (id: string) => ({
  id,
  storeId: STORE,
  orderNumber: `ORD-${id}`,
  total: 1000,
  currency: 'EGP',
  createdAt: new Date(Date.now() - 3_600_000),
  payments: [{ provider: 'paymob' }],
});
const run = () =>
  (
    paymentAbandonmentSweep as unknown as (a: { step: typeof step; event: undefined }) => Promise<{
      stamped: number;
      skipped: number;
    }>
  )({ step, event: undefined });

beforeEach(() => {
  h.selectEnabled.mockReset().mockResolvedValue([STORE]); // the batched check still says enabled
  h.isFeatureEnabled.mockReset();
  h.abandonStamp.mockReset().mockResolvedValue({ stamped: true });
  h.candidates = [order('o1')];
});

describe('payment-abandonment-sweep re-checks the feature live before it stamps', () => {
  it('a feature turned off AFTER the batched check is skipped: no stamp, no push, counted as skipped', async () => {
    h.isFeatureEnabled.mockResolvedValue(false);
    const out = await run();
    expect(h.isFeatureEnabled).toHaveBeenCalledWith(STORE, 'payment_abandonment');
    expect(h.abandonStamp).not.toHaveBeenCalled();
    expect(out).toEqual({ stamped: 0, skipped: 1 });
  });

  it('a store still enabled live is stamped', async () => {
    h.isFeatureEnabled.mockResolvedValue(true);
    const out = await run();
    expect(h.abandonStamp).toHaveBeenCalledWith({ orderId: 'o1' });
    expect(out).toEqual({ stamped: 1, skipped: 0 });
  });

  it('the batched check still narrows: a store it left out is never even checked live', async () => {
    h.selectEnabled.mockResolvedValue([]);
    const out = await run();
    expect(h.isFeatureEnabled).not.toHaveBeenCalled();
    expect(out).toEqual({ stamped: 0, skipped: 1 });
  });
});
