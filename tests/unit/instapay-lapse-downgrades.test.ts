/**
 * #836 (money-abuse audit S4, P1): a lapsed InstaPay subscription never left `past_due`.
 *
 * When the grace ended, `manualPayDue` cleared `nextRetryAt` and suspended the store, and that was all. The due scan
 * only selects `past_due` rows with `nextRetryAt <= now`, so the row was never visited again. getEntitlements gives
 * `past_due` the paid plan's limits, so the merchant kept e.g. Business admin features and AI indefinitely.
 *
 * Now:
 *  - the grace step downgrades to free / `canceled` as well as suspending;
 *  - a row an earlier build left behind (`past_due`, instapay, `nextRetryAt = null`) is selected by the due scan and
 *    downgraded the same way (self-heal);
 *  - getEntitlements treats that lapsed shape as the free plan until the cycle runs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORE = '11111111-1111-4111-8111-111111111111';
const DAY = 86_400_000;

type Row = Record<string, unknown>;
const h = vi.hoisted(() => {
  const st = {
    row: null as null | Record<string, unknown>,
    suspend: vi.fn(),
    effects: vi.fn(),
    storeUpdate: vi.fn(),
    findManyArgs: [] as unknown[],
  };
  const tx = {
    storeSubscription: {
      findUnique: async () => (st.row ? { ...st.row } : null),
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const r = st.row!;
        const match = Object.entries(where).every(([k, v]) =>
          v instanceof Date ? (r[k] as Date)?.getTime() === v.getTime() : r[k] === v
        );
        if (!match) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(st.row!, data),
      findMany: async (args: unknown) => {
        st.findManyArgs.push(args);
        return [];
      },
    },
    plan: { findUnique: async () => ({ code: 'free', featureTier: 'free' }) },
    // the `suspended` notice stage claim (BILL-NOTICE-1)
    billingReminder: { createMany: async () => ({ count: 1 }) },
  };
  return Object.assign(st, { tx });
});
const tx = h.tx;

vi.mock('@ebda/database', () => ({
  prisma: { storeSubscription: h.tx.storeSubscription, plan: h.tx.plan },
  withStore: async (_id: string, fn: (t: unknown) => unknown) => fn(h.tx),
  acrossStores: vi.fn(),
  storeDirectory: vi.fn(),
  currentStoreId: () => null,
}));
vi.mock('@api/lib/definer', () => ({ getEntityStoreId: async () => STORE }));
vi.mock('@api/services/platform/billing-d1', async importOriginal => ({
  ...(await importOriginal<typeof import('@api/services/platform/billing-d1')>()),
  acrossBilling: async (fn: (s?: string) => Promise<unknown>) => [{ value: await fn(undefined) }],
}));
vi.mock('@api/services/billing/account.service', () => ({
  isBillableStoreId: async () => true,
  assertPayableStore: vi.fn(),
  suspendForBilling: h.suspend,
}));
vi.mock('@api/services/billing/billing-notify', () => ({ runBillingEffects: h.effects }));
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn() }));
vi.mock('@api/lib/repo-factory', () => ({ storeUpdate: h.storeUpdate }));

import {
  findDueSubscriptionIds,
  renewSubscription,
} from '@api/services/billing/subscription-billing.service';
import { getEntitlements } from '@api/services/plan-entitlements';

const now = new Date('2026-11-20T10:00:00Z');
const due = new Date(now.getTime() - 4 * DAY);

beforeEach(() => {
  h.suspend.mockReset().mockResolvedValue(true);
  h.effects.mockReset();
  h.storeUpdate.mockReset();
  h.findManyArgs = [];
  h.row = {
    id: 'sub-1',
    storeId: STORE,
    planCode: 'business',
    status: 'past_due',
    billingMethod: 'instapay',
    provider: null,
    providerPaymentMethodRef: null,
    currentPeriodEnd: due,
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    dunningAttempts: 0,
    nextRetryAt: new Date(due.getTime() + 3 * DAY), // grace over before `now`
  };
});

const expectLapsedToFree = () => {
  expect(h.row).toMatchObject({ planCode: 'free', status: 'canceled', nextRetryAt: null });
  expect(h.storeUpdate).toHaveBeenCalledWith(expect.anything(), {
    where: { id: STORE },
    data: { plan: 'free' },
  });
  expect(h.suspend).toHaveBeenCalledWith(STORE, 'unpaid', now);
  const kinds = h.effects.mock.calls.flatMap(c =>
    (c[0] as Array<{ kind: string }>).map(e => e.kind)
  );
  expect(kinds).toEqual(['store_suspended', 'downgraded']);
};

describe('InstaPay grace over: the subscription lapses to free (#836)', () => {
  it('the grace step suspends AND downgrades to free / canceled', async () => {
    await expect(renewSubscription('sub-1', now)).resolves.toEqual({ action: 'suspended' });
    expectLapsedToFree();
  });

  it('a second run the same day changes nothing more', async () => {
    await renewSubscription('sub-1', now);
    h.suspend.mockClear();
    h.effects.mockClear();
    await expect(renewSubscription('sub-1', now)).resolves.toMatchObject({ action: 'skipped' });
    expect(h.suspend).not.toHaveBeenCalled();
    expect(h.effects).not.toHaveBeenCalled();
  });

  it('self-heal: a row an earlier build left past_due with nextRetryAt=null is downgraded', async () => {
    h.row!.nextRetryAt = null;
    await expect(renewSubscription('sub-1', now)).resolves.toEqual({ action: 'suspended' });
    expectLapsedToFree();
  });

  it('the due scan selects such a row', async () => {
    await findDueSubscriptionIds(now);
    const or = (h.findManyArgs[0] as { where: { OR: Row[] } }).where.OR;
    expect(or).toContainEqual({ status: 'past_due', billingMethod: 'instapay', nextRetryAt: null });
  });

  it('control: still inside the grace, nothing lapses', async () => {
    h.row!.nextRetryAt = new Date(now.getTime() + DAY);
    await expect(renewSubscription('sub-1', now)).resolves.toMatchObject({ action: 'skipped' });
    expect(h.row).toMatchObject({ planCode: 'business', status: 'past_due' });
    expect(h.suspend).not.toHaveBeenCalled();
  });
});

describe('getEntitlements resolves the lapsed row to the free plan (#836)', () => {
  const entitlementsFor = (row: Record<string, unknown>) =>
    getEntitlements(
      STORE,
      {
        storeSubscription: { findUnique: async () => row },
        plan: { findUnique: async () => null }, // the seed of the effective code decides
      } as never,
      { legacyPlan: 'enterprise' }
    );

  it('lapsed InstaPay Business row: planCode free (subscribedPlanCode still business)', async () => {
    const e = await entitlementsFor({ ...h.row, nextRetryAt: null });
    expect(e).toMatchObject({
      planCode: 'free',
      subscribedPlanCode: 'business',
      status: 'past_due',
    });
  });

  it('control: a card row past_due with no retry is not an InstaPay lapse (card dunning decides)', async () => {
    const e = await entitlementsFor({ ...h.row, billingMethod: 'card', nextRetryAt: null });
    expect(e?.planCode).toBe('business');
  });

  it('control: inside the grace it keeps Business', async () => {
    const e = await entitlementsFor({ ...h.row, nextRetryAt: new Date(now.getTime() + DAY) });
    expect(e?.planCode).toBe('business');
  });
});
