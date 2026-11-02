/**
 * `store.plan_changed` (contract section 4) on EVERY plan / subscription write: the single database
 * observer that spots such a write, the state it reports (status, periodEnd, includesWhatsApp) and
 * its envelope. Entitlement is a never-stale class: a missed write path is a wrong entitlement.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ ent: vi.fn(), store: vi.fn(), send: vi.fn() }));
vi.mock('@api/services/plan-entitlements', () => ({ getEntitlements: h.ent }));
vi.mock('@api/lib/inngest/send-after-commit', () => ({ sendEventAfterCommit: h.send }));
vi.mock('@ebda/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@ebda/database')>();
  return {
    ...actual,
    prisma: { store: { findUnique: h.store } },
    runInTenantContext: (_s: string, fn: () => unknown) => fn(),
    withStore: (_s: string, fn: (tx: unknown) => unknown) => fn({ store: { findUnique: h.store } }),
  };
});
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { storeEventSchema } from '@api/contracts/wa-v1';
import { buildStoreEvent } from '@api/lib/wa/events';
import {
  PLAN_CHANGED_EVENT,
  notifyPlanChanged,
  planChangeStoreId,
  planChangedInput,
} from '@api/lib/wa/plan-state';

const S = '11111111-1111-4111-8111-111111111111';
const w = (model: string, operation: string, args: object, result: object = {}) => ({
  model,
  operation,
  args,
  result,
});

describe('planChangeStoreId: which writes change a store plan or standing', () => {
  it.each([
    [
      'plan change',
      w('StoreSubscription', 'update', { where: { storeId: S }, data: { planCode: 'business' } }),
    ],
    [
      'dunning to past_due',
      w('StoreSubscription', 'update', { where: { storeId: S }, data: { status: 'past_due' } }),
    ],
    [
      'cancel',
      w('StoreSubscription', 'update', {
        where: { storeId: S },
        data: { cancelAtPeriodEnd: true },
      }),
    ],
    [
      'renewal period',
      w('StoreSubscription', 'update', {
        where: { storeId: S },
        data: { currentPeriodEnd: new Date() },
      }),
    ],
    [
      'trial end',
      w('StoreSubscription', 'updateMany', { where: { storeId: S }, data: { trialEndsAt: null } }),
    ],
    [
      'pending plan',
      w('StoreSubscription', 'update', {
        where: { storeId: S },
        data: { pendingPlanCode: 'growth' },
      }),
    ],
    [
      'new subscription',
      w('StoreSubscription', 'create', { data: { storeId: S, planCode: 'basic' } }),
    ],
    ['removed subscription', w('StoreSubscription', 'delete', { where: { storeId: S } })],
    [
      'upsert that changes the plan',
      w('StoreSubscription', 'upsert', {
        where: { storeId: S },
        create: {},
        update: { planCode: 'pro' },
      }),
    ],
    [
      'legacy store.plan',
      w('Store', 'update', { where: { id: S }, data: { plan: 'enterprise', features: {} } }),
    ],
  ])('%s -> the store', (_n, e) => {
    expect(planChangeStoreId(e)).toBe(S);
  });

  it.each([
    [
      'order counter on the subscription',
      w('StoreSubscription', 'update', {
        where: { storeId: S },
        data: { ordersOverLimitMonth: new Date() },
      }),
    ],
    [
      'order counter upsert',
      w('StoreSubscription', 'upsert', {
        where: { storeId: S },
        create: { storeId: S },
        update: { ordersOverLimitMonth: new Date() },
      }),
    ],
    [
      'card saved',
      w('StoreSubscription', 'update', {
        where: { storeId: S },
        data: { providerPaymentMethodRef: 'x' },
      }),
    ],
    ['a store rename', w('Store', 'update', { where: { id: S }, data: { name: 'x' } })],
    ['a read-shaped op', w('StoreSubscription', 'findUnique', { where: { storeId: S } })],
    ['another model', w('Order', 'update', { where: { id: 'o' }, data: { status: 'cancelled' } })],
  ])('%s -> nothing', (_n, e) => {
    expect(planChangeStoreId(e)).toBeNull();
  });

  it('falls back to the written row when the where clause has no store id', () => {
    expect(
      planChangeStoreId(
        w(
          'StoreSubscription',
          'update',
          { where: { id: 'sub-1' }, data: { status: 'active' } },
          { storeId: S }
        )
      )
    ).toBe(S);
  });
});

describe('notifyPlanChanged', () => {
  beforeEach(() => h.send.mockReset().mockResolvedValue(undefined));
  it('sends the event after commit (not before the write is visible)', async () => {
    await notifyPlanChanged(S);
    expect(h.send).toHaveBeenCalledWith(
      'wa-plan-changed',
      { name: PLAN_CHANGED_EVENT, data: { storeId: S } },
      { ifUnhookable: 'send' }
    );
  });
});

const ent = (over: object = {}) => ({
  storeId: S,
  planCode: 'business',
  status: 'active',
  limits: { whatsappAutomation: true },
  currentPeriodEnd: new Date('2026-12-01T00:00:00Z'),
  trialEndsAt: null,
  pastDueSince: null,
  ...over,
});

describe('planChangedInput (the state sent to Ebda WhatsApp)', () => {
  beforeEach(() => {
    h.ent.mockReset().mockResolvedValue(ent());
    h.store.mockReset().mockResolvedValue({ ownerId: 'owner-1' });
  });
  const NOW = new Date('2026-10-25T10:00:00Z');

  it('an active Business store: includes WhatsApp, active, with the period end and the owner', async () => {
    const p = (await planChangedInput(S, NOW))!;
    expect(p.input).toMatchObject({
      type: 'store.plan_changed',
      storeId: S,
      data: {
        planCode: 'business',
        includesWhatsApp: true,
        ownerUserId: 'owner-1',
        status: 'active',
        periodEnd: '2026-12-01T00:00:00.000Z',
        effectiveAt: NOW.toISOString(),
      },
    });
    const e = await buildStoreEvent(p.input, { seed: p.seed });
    expect(storeEventSchema.safeParse(e).success).toBe(true);
  });

  it.each([
    ['trialing', {}, 'trialing'],
    ['active', {}, 'active'],
    ['comped', {}, 'active'],
    ['none (no subscription row, legacy plan)', {}, 'active'],
    ['past_due (dunning)', {}, 'past_due'],
    ['canceled with period still running', {}, 'cancelled'],
    [
      'canceled and the period is over',
      { currentPeriodEnd: new Date('2026-09-01T00:00:00Z') },
      'expired',
    ],
  ])('subscription %s -> status %s', async (label, over, expected) => {
    const raw = label.split(' ')[0]!;
    h.ent.mockResolvedValue(ent({ status: raw, ...over }));
    expect((await planChangedInput(S, NOW))!.input.data).toMatchObject({ status: expected });
  });

  it('WA-GRACE-1: past_due carries pastDueSince; no other status ever does', async () => {
    const since = new Date('2026-10-20T08:00:00Z');
    h.ent.mockResolvedValue(ent({ status: 'past_due', pastDueSince: since }));
    const p = (await planChangedInput(S, NOW))!;
    expect(p.input.data).toMatchObject({ status: 'past_due', pastDueSince: since.toISOString() });
    expect(
      storeEventSchema.safeParse(await buildStoreEvent(p.input, { seed: p.seed })).success
    ).toBe(true);
    // a stale value on an active row is never sent
    h.ent.mockResolvedValue(ent({ status: 'active', pastDueSince: since }));
    expect((await planChangedInput(S, NOW))!.input.data).not.toHaveProperty('pastDueSince');
    // past_due with no recorded start (should not happen): the field is simply absent
    h.ent.mockResolvedValue(ent({ status: 'past_due', pastDueSince: null }));
    expect((await planChangedInput(S, NOW))!.input.data).not.toHaveProperty('pastDueSince');
  });

  it('WA-GRACE-1: pastDueSince is in the dedupe seed, so a new failure window is a new envelope', async () => {
    h.ent.mockResolvedValue(
      ent({ status: 'past_due', pastDueSince: new Date('2026-10-20T08:00:00Z') })
    );
    const a = (await planChangedInput(S, NOW))!.seed;
    h.ent.mockResolvedValue(
      ent({ status: 'past_due', pastDueSince: new Date('2026-11-20T08:00:00Z') })
    );
    expect((await planChangedInput(S, NOW))!.seed).not.toBe(a);
    h.ent.mockResolvedValue(
      ent({ status: 'past_due', pastDueSince: new Date('2026-10-20T08:00:00Z') })
    );
    expect((await planChangedInput(S, NOW))!.seed).toBe(a); // same state, same id
  });

  it('a pastDueSince write is a plan-relevant write (the observer announces it)', () => {
    expect(
      planChangeStoreId(
        w('StoreSubscription', 'update', {
          where: { storeId: S },
          data: { pastDueSince: new Date() },
        })
      )
    ).toBe(S);
  });

  it('a cancelled store falls back to the free plan: includesWhatsApp false, planCode free', async () => {
    h.ent.mockResolvedValue(
      ent({ status: 'canceled', planCode: 'free', limits: { whatsappAutomation: false } })
    );
    expect((await planChangedInput(S, NOW))!.input.data).toMatchObject({
      planCode: 'free',
      includesWhatsApp: false,
      status: 'cancelled',
    });
  });

  it('a trial uses its end as the period end when there is no billing period yet', async () => {
    h.ent.mockResolvedValue(
      ent({
        status: 'trialing',
        currentPeriodEnd: null,
        trialEndsAt: new Date('2026-11-01T00:00:00Z'),
      })
    );
    expect((await planChangedInput(S, NOW))!.input.data).toMatchObject({
      periodEnd: '2026-11-01T00:00:00.000Z',
    });
  });

  it('same state => same seed (dedupe), any change of plan / standing / period => a new one', async () => {
    const a = (await planChangedInput(S, NOW))!.seed;
    expect((await planChangedInput(S, new Date('2026-10-26T00:00:00Z')))!.seed).toBe(a);
    h.ent.mockResolvedValue(ent({ status: 'past_due' }));
    const b = (await planChangedInput(S, NOW))!.seed;
    h.ent.mockResolvedValue(ent({ currentPeriodEnd: new Date('2027-01-01T00:00:00Z') }));
    const c = (await planChangedInput(S, NOW))!.seed;
    h.ent.mockResolvedValue(ent({ planCode: 'pro' }));
    const d = (await planChangedInput(S, NOW))!.seed;
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it('an unknown store sends nothing', async () => {
    h.ent.mockResolvedValue(null);
    expect(await planChangedInput(S, NOW)).toBeNull();
    h.ent.mockResolvedValue(ent());
    h.store.mockResolvedValue(null);
    expect(await planChangedInput(S, NOW)).toBeNull();
  });
});
