/**
 * NEON-ZERO-1 N-10a money paths on the D1 branch: webhook claim, settle lease, manual payment batch, grants batch.
 */
import { PLATFORM_MIGRATION_SQL } from '../helpers/platform-migrations';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../apps/api/src/services/alerts.service', () => ({
  sendAlert: vi.fn(async () => undefined),
}));
vi.mock('../../apps/api/src/services/billing/billing-notify', () => ({
  runBillingEffects: vi.fn(async () => undefined),
}));
const storeUpdateMock = vi.hoisted(() => vi.fn(async () => ({})));
const captured = vi.hoisted(() => ({
  guard: undefined as undefined | ((m: string, o: string) => void),
  // the D1 `Store` record is not in the platform schema this rig loads: when set, `store.findUnique` answers an ownerless store
  stubStore: false,
}));
vi.mock('../../apps/api/src/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<object>()),
  storeUpdate: storeUpdateMock,
}));
vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/database')>();
  return {
    ...real,
    setRoutedModelGuard: (fn: (m: string, o: string) => void) => {
      captured.guard = fn;
      real.setRoutedModelGuard(fn);
    },
    withStore: (_id: string, fn: (tx: unknown) => unknown) =>
      fn(
        captured.stubStore
          ? new Proxy(real.prisma, {
              get: (t, prop) =>
                prop === 'store'
                  ? { findUnique: async () => ({ ownerId: null, billingSuspendedReason: null }) }
                  : (t as never)[prop],
            })
          : real.prisma
      ),
    currentStoreId: () => '11111111-1111-4111-8111-111111111111',
  };
});

import { prisma, setModelWriteObserver } from '@ebda/database';
import { clearCfBindings, setCfBindings } from '../../apps/api/src/cf/bindings';
import {
  cutoverKey,
  freezeKey,
  platformFamilyOnD1,
  platformFamilyOnD1ForWrite,
  resetCutoverCache,
} from '../../apps/api/src/services/platform/cutover';
import { sendAlert } from '../../apps/api/src/services/alerts.service';
import { reconcilePlanTiers } from '../../apps/api/src/services/billing/subscription-billing.service';
import { registerPlatformRouter } from '../../apps/api/src/services/platform/router';
import { chooseInstapayPlan } from '../../apps/api/src/services/billing/account.service';
import {
  applyGrantsBatchD1,
  commitManualPaymentD1,
  planTierDriftD1,
} from '../../apps/api/src/services/platform/billing-d1';
import { setBillingProviderForTests } from '../../apps/api/src/services/billing';
import {
  handleBillingWebhook,
  processDeferredBillingWebhooks,
  applyWebhookEvent,
  expireStaleCheckouts,
  settleInTx,
} from '../../apps/api/src/services/billing/subscription-billing.service';

const MIG = PLATFORM_MIGRATION_SQL;

const STORE = '11111111-1111-4111-8111-111111111111';
const STORE2 = '22222222-2222-4222-8222-222222222222';

const EV = '33333333-3333-4333-8333-333333333333';

function rig() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(MIG);
  const stmt = (sql: string, v: unknown[]) => {
    if (/^\s*(select|with)/i.test(sql) || /returning/i.test(sql))
      return { results: db.prepare(sql).all(...(v as never[])) as never[], meta: { changes: 0 } };
    return {
      results: [],
      meta: { changes: Number(db.prepare(sql).run(...(v as never[])).changes) },
    };
  };
  const prep = (sql: string) => ({
    bind: (...v: unknown[]) => ({
      all: async () => (await Promise.resolve(), stmt(sql, v)),
      run: async () => (await Promise.resolve(), stmt(sql, v)),
      first: async () => (await Promise.resolve(), (stmt(sql, v).results[0] ?? null) as never),
      __run: () => stmt(sql, v),
    }),
  });
  const d1 = {
    prepare: prep,
    // atomic: roll everything back if a statement throws (D1 batch semantics)
    batch: async (list: Array<{ __run: () => { meta: { changes: number } } }>) => {
      db.exec('BEGIN');
      try {
        const out = list.map(s => s.__run());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  db.prepare(`INSERT INTO stores (id, name, slug, owner_id) VALUES (?, 's', 's', 'o')`).run(STORE);
  for (const [code, tier] of [
    ['free', 'free'],
    ['growth', 'professional'],
    ['basic', 'starter'],
  ] as const)
    db.prepare(
      `INSERT INTO plans (id, code, name_en, name_ar, feature_tier, limits, price_monthly_minor, price_yearly_minor) VALUES (?, ?, ?, ?, ?, '{}', 1000, 10000)`
    ).run(`p-${code}`, code, code, code, tier);
  db.prepare(`INSERT INTO system_settings (id, key, value) VALUES ('c', ?, '{}')`).run(
    cutoverKey('billing')
  );
  setCfBindings({ PLATFORM_DB: d1 } as never);
  return db;
}

beforeEach(() => {
  resetCutoverCache();
  clearCfBindings();
  registerPlatformRouter();
  storeUpdateMock.mockReset();
  storeUpdateMock.mockResolvedValue({});
});

const ledger = (db: DatabaseSync, over: Record<string, unknown> = {}) => {
  const row = {
    id: EV,
    store_id: STORE,
    type: 'checkout',
    plan_code: 'basic',
    billing_interval: 'monthly',
    amount_minor: 1000,
    provider: 'stub',
    idempotency_key: `k-${EV}`,
    status: 'pending',
    ...over,
  };
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO billing_events (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
  ).run(...(Object.values(row) as never[]));
};
const hook = (kind = 'charge.succeeded') =>
  ({
    kind,
    eventId: 'wh-1',
    merchantOrderId: EV,
    providerRef: 'ref-1',
    amountMinor: null,
    failureReason: undefined,
    raw: {},
    customerRef: undefined,
    card: undefined,
  }) as never;

describe('webhook dedupe claim (a throw after the claim must not turn the retry into a replay)', () => {
  it('throw -> claim released -> retry applies -> a third delivery is a replay', async () => {
    const db = rig();
    db.prepare(
      `INSERT INTO store_subscriptions (id, store_id, plan_code, status) VALUES ('s1', ?, 'free', 'active')`
    ).run(STORE);
    ledger(db);
    storeUpdateMock.mockRejectedValueOnce(new Error('postgres down'));
    await expect(applyWebhookEvent('stub', hook())).rejects.toThrow('postgres down');
    expect(db.prepare('SELECT COUNT(*) n FROM billing_webhook_events').get()).toEqual({ n: 0 });
    expect(
      db.prepare('SELECT status, failure_reason f FROM billing_events WHERE id = ?').get(EV)
    ).toEqual({ status: 'pending', f: null });
    expect(db.prepare('SELECT plan_code p FROM store_subscriptions').get()).toEqual({ p: 'free' }); // nothing half-applied

    const second = await applyWebhookEvent('stub', hook());
    expect(second).toMatchObject({ duplicate: false, outcome: 'processed' });
    expect(db.prepare('SELECT status FROM billing_events WHERE id = ?').get(EV)).toEqual({
      status: 'succeeded',
    });
    expect(db.prepare('SELECT plan_code p, status s FROM store_subscriptions').get()).toEqual({
      p: 'basic',
      s: 'active',
    });
    expect(db.prepare('SELECT outcome FROM billing_webhook_events').get()).toEqual({
      outcome: 'processed',
    });

    expect(await applyWebhookEvent('stub', hook())).toMatchObject({
      duplicate: true,
      detail: 'replay',
    });
  });

  it('a fresh in-flight claim answers a retryable 503; a stale one is taken over', async () => {
    const db = rig();
    ledger(db);
    db.prepare(
      `INSERT INTO billing_webhook_events (id, provider, event_id, event_type, outcome, received_at) VALUES ('w', 'stub', 'wh-1', 'charge.succeeded', 'processing', ?)`
    ).run(Date.now());
    await expect(applyWebhookEvent('stub', hook())).rejects.toMatchObject({
      statusCode: 503,
      code: 'WEBHOOK_IN_FLIGHT',
    });
    db.prepare(`UPDATE billing_webhook_events SET received_at = ?`).run(Date.now() - 600_000);
    expect(await applyWebhookEvent('stub', hook())).toMatchObject({ outcome: 'processed' });
  });
});

describe('BILLING-INTERVAL-PENDING-1: a settled card payment drops the InstaPay interval pick', () => {
  const pendingOf = (db: DatabaseSync) =>
    db
      .prepare('SELECT billing_interval i, pending_billing_interval p FROM store_subscriptions')
      .get() as {
      i: string;
      p: string | null;
    };
  it('a card renewal at the stored interval clears pending_billing_interval', async () => {
    const db = rig();
    const end = Date.now() + 86_400_000;
    db.prepare(
      `INSERT INTO store_subscriptions (id, store_id, plan_code, status, billing_interval, pending_billing_interval, current_period_start, current_period_end) VALUES ('s1', ?, 'basic', 'active', 'yearly', 'monthly', ?, ?)`
    ).run(STORE, Date.now() - 364 * 86_400_000, end);
    ledger(db, { type: 'renewal', billing_interval: 'yearly', for_period_end: end });
    await settleInTx(
      prisma as never,
      EV,
      { status: 'succeeded', providerRef: 'r' } as never,
      new Date(),
      []
    );
    expect(pendingOf(db)).toEqual({ i: 'yearly', p: null });
  });
  it('saving a card (card_setup) clears it: a card store renews at its stored interval', async () => {
    const db = rig();
    db.prepare(
      `INSERT INTO store_subscriptions (id, store_id, plan_code, status, billing_interval, pending_billing_interval, current_period_start, current_period_end) VALUES ('s1', ?, 'basic', 'active', 'yearly', 'monthly', ?, ?)`
    ).run(STORE, Date.now() - 1000, Date.now() + 86_400_000);
    ledger(db, { type: 'card_setup', amount_minor: 0 });
    await settleInTx(
      prisma as never,
      EV,
      { status: 'succeeded', providerRef: 'r', cardToken: 'tok_1', cardLast4: '4242' } as never,
      new Date(),
      []
    );
    expect(pendingOf(db)).toEqual({ i: 'yearly', p: null });
  });
});

describe('BILLING-INTERVAL-PENDING-1: an InstaPay interval pick on an active store (D1 subscription)', () => {
  const YEAR = 365 * 86_400_000;
  beforeEach(() => {
    captured.stubStore = true;
    vi.stubEnv('EBDA_INSTAPAY_HANDLE', 'ebda@instapay');
    return () => {
      captured.stubStore = false;
      vi.unstubAllEnvs();
    };
  });
  const subRow = (db: DatabaseSync) =>
    db
      .prepare(
        `SELECT status s, plan_code p, billing_interval i, pending_billing_interval pi, pending_plan_code pp, current_period_end e FROM store_subscriptions`
      )
      .get() as {
      s: string;
      p: string;
      i: string;
      pi: string | null;
      pp: string | null;
      e: number;
    };
  const seedSub = (
    db: DatabaseSync,
    status: 'active' | 'trialing',
    interval: string,
    end: number
  ) =>
    db
      .prepare(
        `INSERT INTO store_subscriptions (id, store_id, plan_code, status, billing_interval, current_period_start, current_period_end, billing_method) VALUES ('s1', ?, 'growth', ?, ?, ?, ?, 'instapay')`
      )
      .run(STORE, status, interval, Date.now(), end);

  it('active yearly store picks monthly: stays yearly with monthly pending, period untouched, payment quote is monthly', async () => {
    const db = rig();
    const end = Date.now() + YEAR;
    seedSub(db, 'active', 'yearly', end);
    const details = await chooseInstapayPlan({
      storeId: STORE,
      planCode: 'growth',
      interval: 'monthly',
    });
    expect(subRow(db)).toMatchObject({ s: 'active', i: 'yearly', pi: 'monthly', e: end });
    expect(details!.interval).toBe('monthly');
  });

  it('pay: recording the monthly payment makes monthly current and clears the pending pick', async () => {
    const db = rig();
    seedSub(db, 'active', 'yearly', Date.now() + YEAR);
    await chooseInstapayPlan({ storeId: STORE, planCode: 'growth', interval: 'monthly' });
    expect(subRow(db).pi).toBe('monthly');
    const sub = db.prepare('SELECT id, updated_at u FROM store_subscriptions').get() as {
      id: string;
      u: number;
    };
    const end = new Date(Date.now() + YEAR + 30 * 86_400_000);
    const out = await commitManualPaymentD1({
      eventId: EV,
      idempotencyKey: 'manual:pend-1',
      storeId: STORE,
      subscriptionId: sub.id,
      planCode: 'growth',
      interval: 'monthly',
      periodStart: new Date(Date.now() + YEAR),
      periodEnd: end,
      amountMinor: 1000,
      providerRef: 'pend-1',
      vatMinor: 0,
      vat: null,
      raw: {},
      anchorDay: 5,
      billingMethod: 'instapay',
      expectedSubUpdatedAt: new Date(sub.u),
      now: new Date(),
    });
    expect(out).toBe('applied');
    expect(subRow(db)).toMatchObject({ s: 'active', i: 'monthly', pi: null, pp: null });
  });

  it('abandon: picking the current interval again leaves the interval untouched', async () => {
    const db = rig();
    seedSub(db, 'active', 'yearly', Date.now() + YEAR);
    await chooseInstapayPlan({ storeId: STORE, planCode: 'growth', interval: 'monthly' });
    await chooseInstapayPlan({ storeId: STORE, planCode: 'growth', interval: 'yearly' });
    expect(subRow(db)).toMatchObject({ i: 'yearly', pi: null });
  });

  it('a trialing store still writes the interval directly (no active period to protect)', async () => {
    const db = rig();
    seedSub(db, 'trialing', 'monthly', Date.now() + 7 * 86_400_000);
    await chooseInstapayPlan({ storeId: STORE, planCode: 'growth', interval: 'yearly' });
    expect(subRow(db)).toMatchObject({ s: 'trialing', i: 'yearly', pi: null });
  });
});

describe('settle lease', () => {
  it('a re-settle after a crash between "subscription moved" and "status flipped" applies nothing twice and raises no false alarm', async () => {
    const db = rig();
    db.prepare(
      `INSERT INTO store_subscriptions (id, store_id, plan_code, status, current_period_start, current_period_end) VALUES ('s1', ?, 'basic', 'active', ?, ?)`
    ).run(STORE, Date.now() + 1000, Date.now() + 30 * 86_400_000);
    // the previous attempt: lease held (expired), subscription already on the new plan, status still pending
    ledger(db, { failure_reason: 'settling', updated_at: Date.now() - 600_000 });
    const startedBefore = (
      db.prepare('SELECT current_period_start s FROM store_subscriptions').get() as { s: number }
    ).s;
    const effects: never[] = [];
    const out = await settleInTx(
      prisma as never,
      EV,
      { status: 'succeeded', providerRef: 'r' } as never,
      new Date(),
      effects
    );
    expect(out.transitioned).toBe(true);
    expect(
      db.prepare('SELECT status, failure_reason f FROM billing_events WHERE id = ?').get(EV)
    ).toEqual({ status: 'succeeded', f: null });
    expect(
      (db.prepare('SELECT current_period_start s FROM store_subscriptions').get() as { s: number })
        .s
    ).toBe(startedBefore);
    expect(storeUpdateMock).toHaveBeenCalledTimes(1); // the Postgres tier is repeated (idempotent), not skipped
    expect(effects).toContainEqual(expect.objectContaining({ kind: 'payment_recorded' }));
  });

  it('expireStaleCheckouts leaves a row that holds the lease alone', async () => {
    const db = rig();
    ledger(db, { failure_reason: 'settling', created_at: Date.now() - 10 * 86_400_000 });
    ledger(db, {
      id: '44444444-4444-4444-8444-444444444444',
      idempotency_key: 'k2',
      created_at: Date.now() - 10 * 86_400_000,
    });
    expect(await expireStaleCheckouts(new Date())).toBe(1);
    expect(db.prepare(`SELECT id, status FROM billing_events ORDER BY id`).all()).toEqual([
      { id: EV, status: 'pending' },
      { id: '44444444-4444-4444-8444-444444444444', status: 'failed' },
    ]);
  });
});

describe('manual payment: ledger + subscription are ONE atomic batch', () => {
  const pay = (over: Record<string, unknown> = {}) => ({
    eventId: EV,
    idempotencyKey: 'manual:ref-1',
    storeId: STORE,
    subscriptionId: null as string | null,
    planCode: 'growth',
    interval: 'monthly',
    periodStart: new Date(1_000_000),
    periodEnd: new Date(9_000_000),
    amountMinor: 5000,
    providerRef: 'ref-1',
    vatMinor: 0,
    vat: null,
    raw: { m: 1 },
    anchorDay: 5,
    billingMethod: 'instapay',
    expectedSubUpdatedAt: null as Date | null,
    now: new Date(2_000_000),
    ...over,
  });

  it('applies both, is idempotent on the key, and a conflicting subscription writes NOTHING', async () => {
    const db = rig();
    expect(await commitManualPaymentD1(pay())).toBe('applied');
    expect(
      db
        .prepare('SELECT plan_code p, status s, current_period_end e FROM store_subscriptions')
        .get()
    ).toEqual({ p: 'growth', s: 'active', e: 9_000_000 });
    expect(db.prepare('SELECT COUNT(*) n FROM billing_events').get()).toEqual({ n: 1 });
    expect(await commitManualPaymentD1(pay({ now: new Date(3_000_000) }))).toBe('duplicate'); // retry, same key
    expect(db.prepare('SELECT updated_at u FROM store_subscriptions').get()).toEqual({
      u: 2_000_000,
    }); // not touched again

    // the subscription moved after the period was computed (expected updated_at is stale) -> nothing is written
    const out = await commitManualPaymentD1(
      pay({
        idempotencyKey: 'manual:ref-2',
        eventId: '55555555-5555-4555-8555-555555555555',
        subscriptionId: 'x',
        expectedSubUpdatedAt: new Date(1),
        now: new Date(4_000_000),
      })
    );
    expect(out).toBe('conflict');
    expect(db.prepare('SELECT COUNT(*) n FROM billing_events').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT current_period_end e FROM store_subscriptions').get()).toEqual({
      e: 9_000_000,
    });
  });
});

describe('free-month grants: subscription move + every grant claim in one batch', () => {
  const setup = (db: DatabaseSync, n = 2) => {
    db.prepare(
      `INSERT INTO store_subscriptions (id, store_id, plan_code, status, current_period_end) VALUES ('s1', ?, 'growth', 'active', 1000)`
    ).run(STORE);
    for (let i = 0; i < n; i++)
      db.prepare(
        `INSERT INTO billing_grants (id, kind, beneficiary_id, status, idempotency_key) VALUES (?, 'founding', ?, 'pending', ?)`
      ).run(`g${i}`, STORE, `k${i}`);
  };
  const args = (n: number, over: Record<string, unknown> = {}) => ({
    storeId: STORE,
    status: 'active',
    currentPeriodEnd: new Date(1000),
    trialEndsAt: null,
    trialing: false,
    now: new Date(5000),
    grants: Array.from({ length: n }, (_, i) => ({
      id: `g${i}`,
      before: new Date(1000 + i * 100),
      after: new Date(1100 + i * 100),
    })),
    ...over,
  });

  it('applies all N and moves the period once', async () => {
    const db = rig();
    setup(db);
    expect(await applyGrantsBatchD1(args(2) as never)).toBe(2);
    expect(db.prepare(`SELECT status FROM billing_grants ORDER BY id`).all()).toEqual([
      { status: 'applied' },
      { status: 'applied' },
    ]);
    expect(db.prepare('SELECT current_period_end e FROM store_subscriptions').get()).toEqual({
      e: 1200,
    });
  });

  it('a subscription that moved underneath loses NO free month: grants stay pending, nothing half-applied', async () => {
    const db = rig();
    setup(db);
    db.prepare('UPDATE store_subscriptions SET current_period_end = 9999').run(); // a renewal landed first
    expect(await applyGrantsBatchD1(args(2) as never)).toBe(0);
    expect(db.prepare(`SELECT status FROM billing_grants`).all()).toEqual([
      { status: 'pending' },
      { status: 'pending' },
    ]);
    expect(db.prepare('SELECT current_period_end e FROM store_subscriptions').get()).toEqual({
      e: 9999,
    });
  });

  it('a grant another run already took makes the whole batch miss (all or nothing)', async () => {
    const db = rig();
    setup(db);
    db.prepare(
      `UPDATE billing_grants SET status = 'applied', applied_at = 1, period_end_before = 1, period_end_after = 2 WHERE id = 'g1'`
    ).run();
    expect(await applyGrantsBatchD1(args(2) as never)).toBe(0);
    expect(db.prepare(`SELECT status FROM billing_grants WHERE id = 'g0'`).get()).toEqual({
      status: 'pending',
    });
    expect(db.prepare('SELECT current_period_end e FROM store_subscriptions').get()).toEqual({
      e: 1000,
    });
  });
});

describe('the write observer (Ebda Chat plan_changed) still sees D1 writes', () => {
  it('router writes, the manual-payment batch and the grants batch all notify it', async () => {
    const db = rig();
    const seen: Array<{ model: string; operation: string }> = [];
    setModelWriteObserver(e => seen.push({ model: e.model, operation: e.operation }));
    try {
      await prisma.storeSubscription.create({ data: { storeId: STORE, planCode: 'growth' } });
      expect(seen).toContainEqual({ model: 'StoreSubscription', operation: 'create' });
      seen.length = 0;
      await prisma.storeSubscription.findUnique({ where: { storeId: STORE } });
      expect(seen).toHaveLength(0); // reads are not writes
      db.prepare('DELETE FROM store_subscriptions').run();
      await commitManualPaymentD1({
        eventId: EV,
        idempotencyKey: 'm',
        storeId: STORE,
        subscriptionId: null,
        planCode: 'growth',
        interval: 'monthly',
        periodStart: new Date(1),
        periodEnd: new Date(2),
        amountMinor: 1,
        providerRef: 'r',
        vatMinor: 0,
        vat: null,
        raw: {},
        anchorDay: 1,
        billingMethod: 'instapay',
        expectedSubUpdatedAt: null,
        now: new Date(3),
      });
      expect(seen.some(e => e.model === 'StoreSubscription')).toBe(true);
    } finally {
      setModelWriteObserver(undefined);
    }
  });
});

describe('freeze lifecycle', () => {
  const putFreeze = (db: DatabaseSync, expiresAt?: number) =>
    db
      .prepare(`INSERT INTO system_settings (id, key, value) VALUES ('f', ?, ?)`)
      .run(freezeKey('billing'), JSON.stringify(expiresAt === undefined ? {} : { expiresAt }));

  it('an EXPIRED freeze is ignored (writes flow) and pages once', async () => {
    const db = rig();
    db.prepare('DELETE FROM system_settings').run(); // no marker
    putFreeze(db, Date.now() - 1000);
    vi.mocked(sendAlert).mockClear();
    expect(await platformFamilyOnD1ForWrite('billing')).toBe(false); // not frozen, not moved
    expect(await platformFamilyOnD1ForWrite('billing')).toBe(false);
    expect(vi.mocked(sendAlert)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendAlert).mock.calls[0][0]).toMatchObject({ level: 'p1' });
  });

  it('marker AND freeze: writes are refused (no mixed backends in the settle window); reads see D1', async () => {
    const db = rig();
    putFreeze(db, Date.now() + 60_000);
    await expect(platformFamilyOnD1ForWrite('billing')).rejects.toMatchObject({
      statusCode: 503,
      code: 'PLATFORM_FAMILY_FROZEN',
    });
    expect(await platformFamilyOnD1('billing')).toBe(true);
    db.prepare('DELETE FROM system_settings WHERE key = ?').run(freezeKey('billing'));
    expect(await platformFamilyOnD1ForWrite('billing')).toBe(true);
  });

  it('"off" is never cached while a freeze row exists', async () => {
    const db = rig();
    db.prepare('DELETE FROM system_settings').run();
    putFreeze(db, Date.now() + 60_000);
    expect(await platformFamilyOnD1('billing')).toBe(false);
    db.prepare(`INSERT INTO system_settings (id, key, value) VALUES ('c2', ?, '{}')`).run(
      cutoverKey('billing')
    );
    expect(await platformFamilyOnD1('billing')).toBe(true); // the very next read sees the marker, no 10 s wait
  });

  it('the frozen error carries a retry hint and an Arabic message for the admin UI', async () => {
    const db = rig();
    db.prepare('DELETE FROM system_settings').run();
    putFreeze(db, Date.now() + 60_000);
    await expect(platformFamilyOnD1ForWrite('billing')).rejects.toMatchObject({
      details: { retryable: true, messageAr: expect.stringContaining('جرّب تاني') },
    });
  });
});

describe('runtime guard: a routed model reaching Postgres after the flip throws', () => {
  it('the registered guard fires for a cached-on family only', async () => {
    rig();
    const guard = captured.guard!;
    expect(() => guard('Plan', 'findMany')).not.toThrow(); // not yet seen on in this isolate: the router's Postgres leg
    await platformFamilyOnD1('billing'); // marker seen -> cached on
    expect(() => guard('Plan', 'findMany')).toThrow(/ROUTED_MODEL_ON_POSTGRES/);
    expect(() => guard('StoreSubscription', 'update')).toThrow(/ROUTED_MODEL_ON_POSTGRES/);
    expect(() => guard('Product', 'findMany')).not.toThrow(); // a model of no routed family is untouched
  });
});

describe('grants batch is chunked under the bound-parameter cap', () => {
  it('120 pending grants apply in chunks, in order, each chunk atomic', async () => {
    const db = rig();
    db.prepare(
      `INSERT INTO store_subscriptions (id, store_id, plan_code, status, current_period_end) VALUES ('s1', ?, 'growth', 'active', 1000)`
    ).run(STORE);
    const grants = Array.from({ length: 120 }, (_, i) => {
      db.prepare(
        `INSERT INTO billing_grants (id, kind, beneficiary_id, status, idempotency_key) VALUES (?, 'founding', ?, 'pending', ?)`
      ).run(`g${i}`, STORE, `k${i}`);
      return { id: `g${i}`, before: new Date(1000 + i), after: new Date(1001 + i) };
    });
    const n = await applyGrantsBatchD1({
      storeId: STORE,
      status: 'active',
      currentPeriodEnd: new Date(1000),
      trialEndsAt: null,
      trialing: false,
      now: new Date(5000),
      grants,
    } as never);
    expect(n).toBe(120);
    expect(
      db.prepare(`SELECT COUNT(*) n FROM billing_grants WHERE status = 'applied'`).get()
    ).toEqual({ n: 120 });
    expect(db.prepare('SELECT current_period_end e FROM store_subscriptions').get()).toEqual({
      e: 1120,
    });
  });
});

describe('stuck leases and tier reconciliation', () => {
  it('a STALE lease no longer blocks expiry; a live one still does', async () => {
    const db = rig();
    const old = Date.now() - 10 * 86_400_000;
    ledger(db, { failure_reason: 'settling', created_at: old, updated_at: Date.now() - 600_000 });
    expect(await expireStaleCheckouts(new Date())).toBe(1);
  });

  it('reconcilePlanTiers repairs stores.plan to the subscription tier and pages', async () => {
    const db = rig();
    db.prepare(
      `INSERT INTO store_subscriptions (id, store_id, plan_code, status) VALUES ('s1', ?, 'growth', 'active')`
    ).run(STORE);
    db.prepare(`UPDATE stores SET plan = 'free' WHERE id = ?`).run(STORE);
    expect(await planTierDriftD1(10)).toEqual([
      { storeId: STORE, current: 'free', tier: 'professional' },
    ]);
    vi.mocked(sendAlert).mockClear();
    expect(await reconcilePlanTiers()).toEqual({ checked: 1, repaired: 1 });
    expect(storeUpdateMock).toHaveBeenCalledWith(expect.anything(), {
      where: { id: STORE },
      data: { plan: 'professional' },
    });
    expect(vi.mocked(sendAlert).mock.calls[0][0]).toMatchObject({ level: 'p1' });
  });

  it('a CANCELED paid subscription is drift while stores.plan keeps the paid tier (#835: repaired to free)', async () => {
    const db = rig();
    // the prod qa-merchant-test shape: status canceled, plan_code growth, stores.plan professional
    db.prepare(
      `INSERT INTO store_subscriptions (id, store_id, plan_code, status) VALUES ('s1', ?, 'growth', 'canceled')`
    ).run(STORE);
    db.prepare(`UPDATE stores SET plan = 'professional' WHERE id = ?`).run(STORE);
    expect(await planTierDriftD1(10)).toEqual([
      { storeId: STORE, current: 'professional', tier: 'free' },
    ]);
    // and an already-free directory row of a canceled subscription is NOT drift
    db.prepare(`UPDATE stores SET plan = 'free' WHERE id = ?`).run(STORE);
    expect(await planTierDriftD1(10)).toEqual([]);
  });
});

// built at runtime: a literal that looks like a credential trips the secret scanner
const CARD_REF = ['card', 'ref', 'plain'].join('-');
const RAW_MARK = ['raw', 'body', 'mark'].join('-');

describe('webhooks during the freeze are deferred, not 503d, and applied exactly once', () => {
  const event = {
    eventId: 'wh-frozen',
    kind: 'charge.succeeded',
    merchantOrderId: EV,
    providerRef: 'ref-9',
    amountMinor: null,
    currency: 'EGP',
    failureReason: undefined,
    card: undefined,
    occurredAt: new Date(),
    raw: {},
  };
  const provider = {
    name: 'stub',
    isConfigured: () => true,
    verifyWebhook: vi.fn(() => ({ ...event })),
  };
  const freezeNow = (db: DatabaseSync) =>
    db
      .prepare(`INSERT INTO system_settings (id, key, value) VALUES ('fz', ?, ?)`)
      .run(freezeKey('billing'), JSON.stringify({ expiresAt: Date.now() + 60_000 }));
  const unfreeze = (db: DatabaseSync) =>
    db.prepare('DELETE FROM system_settings WHERE key = ?').run(freezeKey('billing'));

  function frozenWorld() {
    const db = rig();
    db.prepare(
      `INSERT INTO store_subscriptions (id, store_id, plan_code, status) VALUES ('s1', ?, 'free', 'active')`
    ).run(STORE);
    ledger(db);
    setBillingProviderForTests(provider as never);
    freezeNow(db);
    return db;
  }

  it('authenticated -> stored deferred -> 200; duplicates collapse; nothing applied while frozen', async () => {
    const db = frozenWorld();
    const first = await handleBillingWebhook('stub', Buffer.from('{}'), {});
    expect(first).toEqual({ duplicate: false, outcome: 'deferred', detail: 'family_frozen' });
    await handleBillingWebhook('stub', Buffer.from('{}'), {}); // the provider delivers it twice
    expect(db.prepare(`SELECT outcome FROM billing_webhook_events`).all()).toEqual([
      { outcome: 'deferred' },
    ]);
    expect(db.prepare('SELECT status FROM billing_events WHERE id = ?').get(EV)).toEqual({
      status: 'pending',
    });
    expect(await processDeferredBillingWebhooks()).toBe(0); // still frozen
    expect(storeUpdateMock).not.toHaveBeenCalled();
  });

  it('a deferred row never holds the card token or the raw body in plaintext, and its detail is erased once applied', async () => {
    const db = frozenWorld();
    provider.verifyWebhook.mockImplementation(
      () =>
        ({
          ...event,
          card: { token: CARD_REF, last4: '4242', brand: 'visa' },
        }) as never
    );
    await handleBillingWebhook('stub', Buffer.from(`{"raw":"${RAW_MARK}","v":"${CARD_REF}"}`), {});
    const stored = db.prepare('SELECT detail FROM billing_webhook_events').get() as {
      detail: string;
    };
    expect(stored.detail).toBeTruthy();
    expect(stored.detail).not.toContain(CARD_REF);
    expect(stored.detail).not.toContain(RAW_MARK);
    expect(stored.detail).not.toContain('4242');
    unfreeze(db);
    expect(await processDeferredBillingWebhooks()).toBe(1);
    expect(db.prepare('SELECT outcome, detail FROM billing_webhook_events').get()).toEqual({
      outcome: 'processed',
      detail: null,
    });
    provider.verifyWebhook.mockImplementation(() => ({ ...event }) as never);
  });

  it('a bad signature is NOT stored (authenticate first)', async () => {
    const db = frozenWorld();
    provider.verifyWebhook.mockImplementationOnce(() => {
      throw new Error('INVALID_SIGNATURE');
    });
    await expect(handleBillingWebhook('stub', Buffer.from('{}'), {})).rejects.toThrow(
      'INVALID_SIGNATURE'
    );
    expect(db.prepare('SELECT COUNT(*) n FROM billing_webhook_events').get()).toEqual({ n: 0 });
  });

  it('after the freeze the queue is processed exactly once; a live redelivery afterwards is a replay', async () => {
    const db = frozenWorld();
    await handleBillingWebhook('stub', Buffer.from('{}'), {});
    unfreeze(db);
    expect(await processDeferredBillingWebhooks()).toBe(1);
    expect(db.prepare('SELECT status FROM billing_events WHERE id = ?').get(EV)).toEqual({
      status: 'succeeded',
    });
    expect(db.prepare('SELECT plan_code p FROM store_subscriptions').get()).toEqual({ p: 'basic' });
    expect(db.prepare('SELECT outcome FROM billing_webhook_events').get()).toEqual({
      outcome: 'processed',
    });
    expect(await processDeferredBillingWebhooks()).toBe(0);
    expect(await handleBillingWebhook('stub', Buffer.from('{}'), {})).toMatchObject({
      duplicate: true,
      detail: 'replay',
    });
    expect(storeUpdateMock).toHaveBeenCalledTimes(1); // ONE effect
  });

  it('a live delivery that beats the processor takes the deferred row over; the processor then finds nothing', async () => {
    const db = frozenWorld();
    await handleBillingWebhook('stub', Buffer.from('{}'), {});
    unfreeze(db);
    expect(await handleBillingWebhook('stub', Buffer.from('{}'), {})).toMatchObject({
      outcome: 'processed',
    });
    expect(await processDeferredBillingWebhooks()).toBe(0);
    expect(storeUpdateMock).toHaveBeenCalledTimes(1);
  });

  it('a failed apply puts the row BACK in the queue (the payment is never forgotten) and the next run applies it', async () => {
    const db = frozenWorld();
    await handleBillingWebhook('stub', Buffer.from('{}'), {});
    unfreeze(db);
    storeUpdateMock.mockRejectedValueOnce(new Error('postgres down'));
    expect(await processDeferredBillingWebhooks()).toBe(0);
    expect(db.prepare('SELECT outcome FROM billing_webhook_events').get()).toEqual({
      outcome: 'deferred',
    });
    expect(await processDeferredBillingWebhooks()).toBe(1);
    expect(db.prepare('SELECT status FROM billing_events WHERE id = ?').get(EV)).toEqual({
      status: 'succeeded',
    });
  });
});
