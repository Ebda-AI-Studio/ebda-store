/**
 * NEON-ZERO-1 N-10 (billing family on D1): the cutover switch, the model router on the real `prisma` proxy, and the
 * raw-SQL corners (caps, claims) against the platform migrations on node:sqlite wrapped as an async D1.
 * The Postgres side is never reached: a D1-served call must not need a Postgres client.
 */
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
vi.mock('../../apps/api/src/lib/repo-factory', async importOriginal => ({
  ...(await importOriginal<object>()),
  storeUpdate: storeUpdateMock,
}));
vi.mock('@ebda/database', async importOriginal => {
  const real = await importOriginal<typeof import('@ebda/database')>();
  return {
    ...real,
    // the D1 path needs no Postgres transaction: run the callback on the routed `prisma` proxy
    withStore: (_id: string, fn: (tx: unknown) => unknown) => fn(real.prisma),
    currentStoreId: () => '11111111-1111-4111-8111-111111111111',
  };
});

import {
  prisma,
  routeTx,
  setModelRouter,
  withMoneyTx,
  scopeTransaction,
  afterTxCommit,
} from '@ebda/database';
import { clearCfBindings, setCfBindings } from '../../apps/api/src/cf/bindings';
import {
  assertFamilyWritableOnPostgres,
  platformFamilyOnD1ForWrite,
  freezeKey,
  OFF_TTL_MS,
  cutoverKey,
  platformFamilyOnD1,
  resetCutoverCache,
} from '../../apps/api/src/services/platform/cutover';
import {
  platformRouter,
  registerPlatformRouter,
} from '../../apps/api/src/services/platform/router';
import {
  claimRestoreD1,
  entityStoreIdD1,
  insertCappedGrant,
  planSubscriberCountsD1,
  refundStoreIdD1,
  revokeGrantsD1,
  storeIdsOnPlanD1,
} from '../../apps/api/src/services/platform/billing-d1';
import {
  getStoreSubscription,
  startSignupTrial,
  syncSubscriptionFromLegacyPlan,
} from '../../apps/api/src/services/platform/subscriptions';

const MIG = ['0001_init.sql', '0002_invariants.sql']
  .map(f =>
    fs.readFileSync(
      new URL(`../../packages/cf-schema/migrations/platform/${f}`, import.meta.url),
      'utf8'
    )
  )
  .join('\n');

const STORE = '11111111-1111-4111-8111-111111111111';
const STORE2 = '22222222-2222-4222-8222-222222222222';

function rig() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(MIG);
  const log: string[] = [];
  const exec = (sql: string, v: unknown[]) => {
    log.push(sql);
    if (/^\s*(select|with)/i.test(sql) || /returning/i.test(sql))
      return { results: db.prepare(sql).all(...(v as never[])) as never[], meta: { changes: 0 } };
    return {
      results: [],
      meta: { changes: Number(db.prepare(sql).run(...(v as never[])).changes) },
    };
  };
  const d1 = {
    prepare: (sql: string) => ({
      bind: (...v: unknown[]) => ({
        all: async () => (await Promise.resolve(), exec(sql, v)),
        run: async () => (await Promise.resolve(), exec(sql, v)),
        first: async () => (await Promise.resolve(), (exec(sql, v).results[0] ?? null) as never),
      }),
    }),
  };
  const store = (id: string, slug: string) =>
    db
      .prepare(`INSERT INTO stores (id, name, slug, owner_id) VALUES (?, ?, ?, 'owner-1')`)
      .run(id, slug, slug);
  return { db, d1, log, store };
}

const seedPlans = (db: DatabaseSync) => {
  for (const [code, tier] of [
    ['free', 'free'],
    ['growth', 'professional'],
    ['basic', 'starter'],
  ] as const)
    db.prepare(
      `INSERT INTO plans (id, code, name_en, name_ar, feature_tier, limits) VALUES (?, ?, ?, ?, ?, '{}')`
    ).run(`plan-${code}`, code, code, code, tier);
};
const cutover = (db: DatabaseSync) =>
  db
    .prepare(`INSERT INTO system_settings (id, key, value) VALUES ('c1', ?, '{}')`)
    .run(cutoverKey('billing'));

beforeEach(() => {
  resetCutoverCache();
  clearCfBindings();
  registerPlatformRouter();
});

describe('family table list', () => {
  it('the copy script and the API router name the same tables', async () => {
    const { FAMILIES } = await import('../../scripts/cf/cutover-platform-family.mjs');
    const meta = (await import('../../packages/cf-schema/generated/prisma-meta.json')).default as {
      models: Record<string, { table: string; db: string }>;
    };
    const { FAMILY_MODELS } = await import('../../apps/api/src/services/platform/cutover');
    const tables = FAMILY_MODELS.billing.map(m => {
      const model = meta.models[m[0].toUpperCase() + m.slice(1)];
      expect(model?.db, m).toBe('d1');
      return model.table;
    });
    expect([...tables].sort()).toEqual([...FAMILIES.billing].sort());
  });
});

const freeze = (db: DatabaseSync) =>
  db
    .prepare(`INSERT INTO system_settings (id, key, value) VALUES ('f1', ?, '{}')`)
    .run(freezeKey('billing'));

describe('freeze (no write is silently lost between the snapshot and the flip)', () => {
  it('a write is refused while frozen and the family has not moved; reads are not', async () => {
    const r = rig();
    freeze(r.db);
    setCfBindings({ PLATFORM_DB: r.d1 } as never);
    const pg = vi.fn(async () => 'pg');
    await expect(platformRouter.route('storeSubscription', 'update', [], pg)).rejects.toMatchObject(
      {
        statusCode: 503,
        code: 'PLATFORM_FAMILY_FROZEN',
      }
    );
    await expect(platformRouter.route('billingEvent', 'createMany', [], pg)).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(pg).not.toHaveBeenCalled();
    expect(await platformRouter.route('storeSubscription', 'findUnique', [], pg)).toBe('pg');
    await expect(assertFamilyWritableOnPostgres('billing')).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it('a write never trusts a cached "off": the moment the marker exists it goes to D1', async () => {
    const r = rig();
    seedPlans(r.db);
    setCfBindings({ PLATFORM_DB: r.d1 } as never);
    expect(await platformFamilyOnD1('billing')).toBe(false); // cached off for OFF_TTL_MS
    cutover(r.db);
    expect(await platformFamilyOnD1('billing')).toBe(false); // a READ may still be stale ...
    expect(await platformFamilyOnD1ForWrite('billing')).toBe(true); // ... a WRITE is not
    await prisma.plan.create({
      data: { code: 'x', nameEn: 'x', nameAr: 'x', featureTier: 'free', limits: {} },
    });
    expect(
      (r.db.prepare('SELECT COUNT(*) n FROM plans WHERE code = ?').get('x') as { n: number }).n
    ).toBe(1);
  });

  it('a write between BEGIN and flip is refused (frozen), a write after the flip lands in D1: never in Postgres', async () => {
    const r = rig();
    seedPlans(r.db);
    r.store(STORE, 'a');
    setCfBindings({ PLATFORM_DB: r.d1 } as never);
    const pg = vi.fn(async () => 'pg-write');
    freeze(r.db); // script: FREEZE
    await expect(platformRouter.route('storeSubscription', 'create', [], pg)).rejects.toMatchObject(
      { statusCode: 503 }
    );
    cutover(r.db); // script: FLIP (the freeze is still up for the settle window)
    await prisma.storeSubscription.create({ data: { storeId: STORE, planCode: 'growth' } });
    expect(pg).not.toHaveBeenCalled();
    expect(
      (r.db.prepare('SELECT COUNT(*) n FROM store_subscriptions').get() as { n: number }).n
    ).toBe(1);
  });
});

describe('raw transactions are routed (no billing model reaches Postgres after the flip)', () => {
  const rawTx = () => ({
    storeSubscription: { findUnique: vi.fn(async () => 'PG-ROW') },
    $queryRaw: vi.fn(async () => []),
  });

  it('routeTx / withMoneyTx / scopeTransaction hand callers a client whose billing models route', async () => {
    const r = rig();
    seedPlans(r.db);
    r.store(STORE, 'a');
    cutover(r.db);
    r.db
      .prepare(
        `INSERT INTO store_subscriptions (id, store_id, plan_code) VALUES ('s1', ?, 'growth')`
      )
      .run(STORE);
    setCfBindings({ PLATFORM_DB: r.d1 } as never);
    const read = async (tx: {
      storeSubscription: { findUnique: (a: unknown) => Promise<unknown> };
    }) => tx.storeSubscription.findUnique({ where: { storeId: STORE } });

    expect(await read(routeTx(rawTx()) as never)).toMatchObject({ planCode: 'growth' });
    const viaMoney = await withMoneyTx(
      { $transaction: (fn: (t: unknown) => unknown) => fn(rawTx()) } as never,
      t => read(t as never)
    );
    expect(viaMoney).toMatchObject({ planCode: 'growth' });
    const gucTx = {
      ...rawTx(),
      $executeRaw: vi.fn(async () => 0),
      $queryRawUnsafe: vi.fn(async () => []),
    };
    const viaScope = await scopeTransaction(gucTx as never, { storeId: STORE, userId: STORE2 }, t =>
      read(t as never)
    );
    expect(viaScope).toMatchObject({ planCode: 'growth' });
  });

  it('before the flip the same client reaches Postgres; a non-billing property is untouched', async () => {
    const r = rig();
    setCfBindings({ PLATFORM_DB: r.d1 } as never);
    const tx = rawTx() as typeof rawTx extends () => infer T ? T : never;
    const routed = routeTx(tx) as typeof tx;
    expect(await routed.storeSubscription.findUnique()).toBe('PG-ROW');
    await routed.$queryRaw();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('after-commit hooks registered through the wrapper reach the transaction they belong to', async () => {
    let seen: unknown;
    await withMoneyTx(
      { $transaction: (fn: (t: unknown) => unknown) => fn(rawTx()) } as never,
      async t => {
        seen = afterTxCommit(t as object, () => undefined);
      }
    );
    expect(seen).toBe(true);
  });
});

describe('cutover switch', () => {
  it('no binding -> Postgres, no marker read', async () => {
    expect(await platformFamilyOnD1('billing')).toBe(false);
    const pg = vi.fn(async () => 'pg');
    expect(await platformRouter.route('plan', 'findMany', [], pg)).toBe('pg');
    expect(pg).toHaveBeenCalledTimes(1);
  });

  it('binding but no marker -> Postgres; "off" is re-read only after OFF_TTL_MS; "on" is cached for good', async () => {
    vi.useFakeTimers();
    try {
      const r = rig();
      setCfBindings({ PLATFORM_DB: r.d1 } as never);
      expect(await platformFamilyOnD1('billing')).toBe(false);
      expect(await platformFamilyOnD1('billing')).toBe(false);
      expect(r.log.filter(s => /system_settings/.test(s))).toHaveLength(1);
      cutover(r.db);
      expect(await platformFamilyOnD1('billing')).toBe(false); // still inside the window
      vi.advanceTimersByTime(OFF_TTL_MS + 1);
      expect(await platformFamilyOnD1('billing')).toBe(true);
      const reads = r.log.length;
      expect(await platformFamilyOnD1('billing')).toBe(true);
      expect(r.log.length).toBe(reads); // cached
    } finally {
      vi.useRealTimers();
    }
  });

  it('an unreadable marker fails closed with 503, never Postgres', async () => {
    setCfBindings({
      PLATFORM_DB: {
        prepare: () => ({ bind: () => ({ all: async () => Promise.reject(new Error('down')) }) }),
      },
    } as never);
    await expect(platformFamilyOnD1('billing')).rejects.toMatchObject({ statusCode: 503 });
  });

  it('the router is registered on the prisma proxy for exactly the billing and ai-usage models', () => {
    expect([...platformRouter.models].sort()).toEqual(
      [
        'aiUsage', // Ruling NZ-AN-1: the platform-wide AI usage family
        'billingEvent',
        'billingGrant',
        'billingReferral',
        'billingReminder',
        'billingWebhookEvent',
        'plan',
        'storeLifecycleEmail',
        'storeSubscription',
      ].sort()
    );
    setModelRouter(undefined);
    registerPlatformRouter();
  });
});

describe('prisma proxy after the cutover (D1 only, no Postgres client)', () => {
  it('subscription API: sync from legacy plan, trial, read - one row, no Postgres', async () => {
    const r = rig();
    seedPlans(r.db);
    r.store(STORE, 'a');
    cutover(r.db);
    setCfBindings({ PLATFORM_DB: r.d1 } as never);

    await syncSubscriptionFromLegacyPlan(prisma as never, STORE, 'starter');
    expect(await getStoreSubscription(STORE)).toMatchObject({
      planCode: 'basic',
      status: 'active',
    });

    const now = new Date('2026-11-04T10:00:00Z');
    await startSignupTrial(prisma as never, STORE, { planCode: 'basic', interval: 'yearly' }, now);
    const sub = await getStoreSubscription(STORE);
    expect(sub).toMatchObject({
      planCode: 'growth',
      status: 'trialing',
      pendingPlanCode: 'basic',
      billingInterval: 'yearly',
    });
    expect(sub?.trialEndsAt?.toISOString()).toBe('2026-11-18T10:00:00.000Z');
    expect(
      (r.db.prepare('SELECT COUNT(*) n FROM store_subscriptions').get() as { n: number }).n
    ).toBe(1);

    // re-saving a store on the same tier keeps a hidden/granted plan, and a re-assignment resets the over-limit slate
    await syncSubscriptionFromLegacyPlan(prisma as never, STORE, 'professional');
    expect(await getStoreSubscription(STORE)).toMatchObject({
      planCode: 'growth',
      status: 'active',
    });
  });

  it('the past-due trigger runs on D1 (pastDueSince set once, cleared on recovery)', async () => {
    const r = rig();
    seedPlans(r.db);
    r.store(STORE, 'a');
    cutover(r.db);
    setCfBindings({ PLATFORM_DB: r.d1 } as never);
    await prisma.storeSubscription.create({
      data: { storeId: STORE, planCode: 'growth', status: 'active' },
    });
    await prisma.storeSubscription.update({
      where: { storeId: STORE },
      data: { status: 'past_due' },
    });
    const first = (await getStoreSubscription(STORE))?.pastDueSince;
    expect(first).toBeInstanceOf(Date);
    await prisma.storeSubscription.update({
      where: { storeId: STORE },
      data: { dunningAttempts: 1 },
    });
    expect((await getStoreSubscription(STORE))?.pastDueSince?.getTime()).toBe(first!.getTime());
    await prisma.storeSubscription.update({
      where: { storeId: STORE },
      data: { status: 'active' },
    });
    expect((await getStoreSubscription(STORE))?.pastDueSince).toBeNull();
  });

  it('ledger: createMany skipDuplicates is idempotent on the key and the append-only triggers hold', async () => {
    const r = rig();
    seedPlans(r.db);
    r.store(STORE, 'a');
    cutover(r.db);
    setCfBindings({ PLATFORM_DB: r.d1 } as never);
    const row = (id: string) => ({
      id,
      storeId: STORE,
      type: 'renewal',
      amountMinor: 1000,
      currency: 'EGP',
      provider: 'kashier',
      idempotencyKey: 'k1',
      status: 'pending',
    });
    expect(
      (await prisma.billingEvent.createMany({ data: [row('e1')], skipDuplicates: true })).count
    ).toBe(1);
    expect(
      (await prisma.billingEvent.createMany({ data: [row('e2')], skipDuplicates: true })).count
    ).toBe(0);
    // the settle CAS: pending -> succeeded once
    const cas = () =>
      prisma.billingEvent.updateMany({
        where: { id: 'e1', status: { in: ['pending', 'failed'] } },
        data: { status: 'succeeded' },
      });
    expect((await cas()).count).toBe(1);
    expect((await cas()).count).toBe(0);
    // succeeded is final: the invariant the settle lease was designed around
    await expect(
      prisma.billingEvent.updateMany({ where: { id: 'e1' }, data: { status: 'pending' } })
    ).rejects.toThrow();
  });

  it('settle lease expression: OR(null / not lease / stale updatedAt) selects the right rows', async () => {
    const r = rig();
    seedPlans(r.db);
    r.store(STORE, 'a');
    cutover(r.db);
    setCfBindings({ PLATFORM_DB: r.d1 } as never);
    const base = {
      storeId: STORE,
      type: 'renewal',
      amountMinor: 1,
      currency: 'EGP',
      provider: 'p',
      status: 'pending',
    };
    await prisma.billingEvent.createMany({
      data: [
        { id: 'a', idempotencyKey: 'a', ...base },
        { id: 'b', idempotencyKey: 'b', ...base, failureReason: 'card_declined' },
      ],
    });
    const now = new Date();
    const lease = (id: string) =>
      prisma.billingEvent.updateMany({
        where: {
          id,
          status: { in: ['pending', 'failed'] },
          OR: [
            { failureReason: null },
            { failureReason: { not: 'settling' } },
            { updatedAt: { lt: new Date(now.getTime() - 120_000) } },
          ],
        },
        data: { failureReason: 'settling' },
      });
    expect((await lease('a')).count).toBe(1);
    expect((await lease('a')).count).toBe(0); // held
    expect((await lease('b')).count).toBe(1); // a previous failure reason does not block
    r.db
      .prepare(`UPDATE billing_events SET updated_at = ? WHERE id = 'a'`)
      .run(now.getTime() - 200_000);
    expect((await lease('a')).count).toBe(1); // stale lease is stolen
  });
});

describe('raw D1 corners', () => {
  it('insertCappedGrant: the cap holds under concurrency and is idempotent per key', async () => {
    const r = rig();
    seedPlans(r.db);
    for (const [i, id] of [STORE, STORE2].entries()) r.store(id, `s${i}`);
    setCfBindings({ PLATFORM_DB: r.d1 } as never);
    const g = (n: number) => ({
      id: `g${n}`,
      kind: 'founding',
      beneficiaryId: n % 2 ? STORE : STORE2,
      counterpartId: null,
      valueMinor: 100,
      key: `founding:${n}`,
      sourceEventId: `ev${n}`,
      sourceStoreId: STORE,
    });
    const cap = { kind: 'founding', max: 3 };
    const res = await Promise.all([1, 2, 3, 4, 5, 6].map(n => insertCappedGrant(g(n), cap)));
    expect(res.filter(Boolean)).toHaveLength(3);
    expect(await insertCappedGrant(g(1), { kind: 'founding', max: 99 })).toBe(false); // same key: idempotent
    // revoking gives the slot back
    await revokeGrantsD1('ev1', 'payment_refunded', new Date());
    const more = await insertCappedGrant(g(7), cap);
    expect(more).toBe(true);
    // per-beneficiary cap
    const per = { kind: 'founding', beneficiaryId: STORE, max: 1 };
    expect(await insertCappedGrant({ ...g(9), key: 'x9', beneficiaryId: STORE }, per)).toBe(false);
  });

  it('revoke is one-shot; restore claim is one-shot and returns the moved period', async () => {
    const r = rig();
    r.store(STORE, 'a');
    setCfBindings({ PLATFORM_DB: r.d1 } as never);
    r.db
      .prepare(
        `INSERT INTO billing_grants (id, kind, beneficiary_id, status, idempotency_key, source_event_id, period_end_before, period_end_after, applied_at)
         VALUES ('g1','founding',?, 'applied','k','ev1', 1000, 2000, 5)`
      )
      .run(STORE);
    const now = new Date(1500);
    expect(await revokeGrantsD1('ev1', 'payment_refunded', now)).toEqual([
      { id: 'g1', beneficiary_id: STORE },
    ]);
    expect(await revokeGrantsD1('ev1', 'payment_refunded', now)).toEqual([]);
    const claim = await claimRestoreD1('g1', now);
    expect(claim).toEqual({ before: new Date(1000), after: new Date(2000) });
    expect(await claimRestoreD1('g1', now)).toBeNull();
  });

  it('definer replacements: subscriber counts, store ids on a plan, entity -> store, refund routing', async () => {
    const r = rig();
    seedPlans(r.db);
    r.store(STORE, 'a');
    r.store(STORE2, 'b');
    setCfBindings({ PLATFORM_DB: r.d1 } as never);
    r.db
      .prepare(
        `INSERT INTO store_subscriptions (id, store_id, plan_code) VALUES ('s1', ?, 'growth')`
      )
      .run(STORE);
    r.db
      .prepare(
        `INSERT INTO store_subscriptions (id, store_id, plan_code) VALUES ('s2', ?, 'growth')`
      )
      .run(STORE2);
    r.db
      .prepare(
        `INSERT INTO billing_events (id, store_id, type, amount_minor, provider, provider_ref, idempotency_key, status)
         VALUES ('e1', ?, 'refund', 5, 'kashier', 'ref-1', 'k-refund', 'pending')`
      )
      .run(STORE2);
    expect(await planSubscriberCountsD1()).toEqual(new Map([['growth', 2]]));
    expect((await storeIdsOnPlanD1('growth')).sort()).toEqual([STORE, STORE2]);
    expect(await entityStoreIdD1('store_subscription', 's2')).toBe(STORE2);
    expect(await entityStoreIdD1('billing_event', 'e1')).toBe(STORE2);
    expect(await entityStoreIdD1('billing_event', 'nope')).toBeNull();
    expect(await refundStoreIdD1('kashier', 'ref-1')).toBe(STORE2);
    expect(await refundStoreIdD1('kashier', 'other')).toBeNull();
  });
});
