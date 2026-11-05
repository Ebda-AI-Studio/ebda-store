/**
 * N-18 (Ruling NZ-D11): a store created on D1 + its Durable Object has NO Postgres row. Real platform migration (node:sqlite as the
 * D1), real DO store schema, the real `bootstrapStoreRows`, Postgres POISONED: any touch throws.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  bootstrapStoreRows,
  encodeRpc,
  decodeRpc,
  readStoreRecord,
  createD1Client,
} from '@ebda-src/repo';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';
import { META, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';

const h = vi.hoisted(() => ({
  d1: null as unknown,
  doDb: null as unknown,
  bootstrapCalls: 0,
  failBootstrap: false,
  failCoa: false,
  coaCalls: [] as string[],
  alert: vi.fn(async () => undefined),
  failDelete: false,
}));

vi.mock('@ebda/database', () => {
  const boom = () => {
    throw new Error('POSTGRES TOUCHED');
  };
  return {
    prisma: new Proxy({}, { get: boom }),
    withStore: boom,
    withUser: boom,
    withSystemJob: boom,
    afterTxCommit: () => false,
    afterTenantTxCommit: () => false,
    runInTenantContext: boom,
    onClosedTenantTxAccess: () => undefined,
  };
});
vi.mock('../../apps/api/src/lib/store-backend', () => ({
  backendFor: async () => 'do',
  storeDo: () => ({
    bootstrapStore: async (id: string, json: string) => {
      h.bootstrapCalls++;
      if (h.failBootstrap) return { ok: false, code: 'BOOTSTRAP_REFUSED', status: 409 };
      return {
        ok: true,
        data: bootstrapStoreRows(
          nodeSqlRunner(h.doDb as DatabaseSync),
          META as never,
          id,
          decodeRpc(json)
        ),
      };
    },
    storeRecord: async (id: string, fields?: string[]) => {
      const r = readStoreRecord(nodeSqlRunner(h.doDb as DatabaseSync), META as never, id, fields);
      return r
        ? { ok: true, data: { json: encodeRpc(r.record), missing: r.missing } }
        : { ok: false, code: 'STORE_NOT_FOUND', status: 404 };
    },
  }),
}));
vi.mock('../../apps/api/src/lib/platform-db', () => ({
  requirePlatformDb: async () => h.d1,
  platformDb: async () => h.d1,
}));
vi.mock('../../apps/api/src/services/accounting/account.service', () => ({
  seedCoaForStore: async (id: string) => {
    h.coaCalls.push(id);
    if (h.failCoa) throw new Error('coa down');
    return 27;
  },
}));
vi.mock('../../apps/api/src/services/alerts.service', () => ({
  sendAlert: h.alert,
}));

import { setCfBindings, clearCfBindings } from '../../apps/api/src/cf/bindings';
import {
  countOwnerStores,
  countOwnerStoresCreatedSince,
  finishDoStoreCreate,
  insertDoStore,
  ownerStores,
  storeCreateOnDo,
  type NewDoStore,
} from '../../apps/api/src/lib/store-create-do';

let sqlite: DatabaseSync;
const fakeD1 = () => ({
  batch: async (stmts: Array<{ run(): Promise<unknown> }>) => {
    sqlite.exec('BEGIN');
    try {
      const out: unknown[] = [];
      for (const st of stmts) out.push(await st.run());
      sqlite.exec('COMMIT');
      return out;
    } catch (e) {
      sqlite.exec('ROLLBACK');
      throw e;
    }
  },
  prepare: (sql: string) => ({
    bind: (...v: unknown[]) => {
      const run = async () => {
        await Promise.resolve();
        if (h.failDelete && /^\s*delete/i.test(sql)) throw new Error('d1 down');
        if (/^\s*select/i.test(sql)) return { results: sqlite.prepare(sql).all(...(v as never[])) };
        return { meta: { changes: Number(sqlite.prepare(sql).run(...(v as never[])).changes) } };
      };
      return {
        run,
        first: async () => ((await run()) as { results: unknown[] }).results[0] ?? null,
        all: run,
      };
    },
  }),
});

const input = (over: Partial<NewDoStore> = {}): NewDoStore => ({
  name: 'Nour',
  slug: 'nour',
  ownerId: 'owner-1',
  status: 'inactive',
  plan: 'professional',
  settings: { currency: 'EGP' },
  theme: { frameChromeDedup: true },
  layoutSettings: {},
  vatRateHundredths: 1400,
  cod: { name: 'Cash on Delivery', nameAr: 'الدفع عند الاستلام', currency: 'EGP' },
  ...over,
});

const d1Stores = () =>
  sqlite
    .prepare('SELECT id, slug, owner_id, storage_backend, status, plan FROM stores')
    .all() as Array<Record<string, unknown>>;

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(
    ['0001_init.sql', '0002_invariants.sql']
      .map(f =>
        fs.readFileSync(
          new URL(`../../packages/cf-schema/migrations/platform/${f}`, import.meta.url),
          'utf8'
        )
      )
      .join('\n')
  );
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const p of DEFAULT_PLAN_SEEDS)
    sqlite
      .prepare(
        'INSERT INTO plans (id, code, name_en, name_ar, feature_tier, limits) VALUES (?,?,?,?,?,?)'
      )
      .run(`plan-${p.code}`, p.code, p.nameEn, p.nameAr, p.featureTier, JSON.stringify(p.limits));
  h.d1 = createD1Client(META as never, fakeD1() as never);
  h.doDb = openSqlite();
  h.bootstrapCalls = 0;
  h.failBootstrap = false;
  h.failCoa = false;
  h.coaCalls.length = 0;
  h.alert.mockClear();
  h.failDelete = false;
  setCfBindings({ PLATFORM_DB: fakeD1(), STORE_DO: {} } as never);
  process.env.STORE_CREATE_ON_DO = '1';
});

describe('storeCreateOnDo', () => {
  it('is on only with the env flag AND both bindings', () => {
    expect(storeCreateOnDo()).toBe(true);
    process.env.STORE_CREATE_ON_DO = '0';
    expect(storeCreateOnDo()).toBe(false);
    process.env.STORE_CREATE_ON_DO = '1';
    setCfBindings({ PLATFORM_DB: fakeD1() } as never);
    expect(storeCreateOnDo()).toBe(false);
    clearCfBindings();
    expect(storeCreateOnDo()).toBe(false);
  });
});

describe('insertDoStore + finishDoStoreCreate (Postgres poisoned)', () => {
  it('writes the D1 store + trial subscription in ONE batch, bootstraps the DO, seeds the chart, returns the record', async () => {
    const id = await insertDoStore(input({ trial: {} }));
    const rec = await finishDoStoreCreate(id, { slug: 'nour' });
    expect(d1Stores()).toEqual([
      expect.objectContaining({
        id,
        slug: 'nour',
        owner_id: 'owner-1',
        storage_backend: 'do',
        status: 'inactive',
        plan: 'professional',
      }),
    ]);
    const doDb = h.doDb as DatabaseSync;
    expect(doDb.prepare('SELECT slug, owner_id, status FROM store_profile').all()).toEqual([
      { slug: 'nour', owner_id: 'owner-1', status: 'inactive' },
    ]);
    expect(doDb.prepare('SELECT name, rate, is_active FROM tax_rates').all()).toEqual([
      { name: 'VAT', rate: 1400, is_active: 0 },
    ]);
    expect(doDb.prepare('SELECT provider, is_enabled FROM payment_configs').all()).toEqual([
      { provider: 'cod', is_enabled: 1 },
    ]);
    expect(
      sqlite
        .prepare(
          'SELECT plan_code, status, pending_plan_code, billing_interval FROM store_subscriptions WHERE store_id = ?'
        )
        .all(id)
    ).toEqual([
      {
        plan_code: 'growth',
        status: 'trialing',
        pending_plan_code: 'growth',
        billing_interval: 'monthly',
      },
    ]);
    expect(h.coaCalls).toEqual([id]);
    expect(rec).toMatchObject({ id, name: 'Nour', slug: 'nour', ownerId: 'owner-1' });
  });

  it('a second store for the owner (no trial) rides its plan: active subscription, no trial', async () => {
    const id = await insertDoStore(input({ slug: 'two', plan: 'enterprise' }));
    const sub = sqlite
      .prepare('SELECT status, trial_ends_at FROM store_subscriptions WHERE store_id = ?')
      .get(id) as Record<string, unknown>;
    expect(sub).toEqual({ status: 'active', trial_ends_at: null });
  });

  it('a taken slug is SLUG_TAKEN (409), the same code the Postgres path answers; nothing reaches the DO', async () => {
    await insertDoStore(input());
    await expect(insertDoStore(input())).rejects.toMatchObject({
      statusCode: 409,
      code: 'SLUG_TAKEN',
    });
    expect(h.bootstrapCalls).toBe(1);
    expect(d1Stores()).toHaveLength(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM store_subscriptions').get()).toEqual({ n: 1 });
  });

  it('a NOT NULL / CHECK failure is NOT reported as a taken slug', async () => {
    await expect(insertDoStore(input({ status: 'bogus' as never }))).rejects.toMatchObject({
      statusCode: 503,
      code: 'STORE_DIRECTORY_UNAVAILABLE',
    });
    expect(d1Stores()).toEqual([]);
  });

  it('the plan gate is ATOMIC in the insert: past the allowance the second create is refused and leaves nothing', async () => {
    await insertDoStore(input({ slug: 'g1', maxOwnedStores: 1 }));
    await expect(insertDoStore(input({ slug: 'g2', maxOwnedStores: 1 }))).rejects.toMatchObject({
      code: 'STORE_LIMIT_REACHED',
    });
    expect(d1Stores()).toHaveLength(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM store_subscriptions').get()).toEqual({ n: 1 });
    // unlimited (null) and operator creates are not gated
    await expect(insertDoStore(input({ slug: 'g3', maxOwnedStores: null }))).resolves.toBeTruthy();
  });

  it('a DO bootstrap failure removes the D1 row (and its subscription) again', async () => {
    h.failBootstrap = true;
    await expect(insertDoStore(input())).rejects.toMatchObject({ code: 'BOOTSTRAP_REFUSED' });
    expect(d1Stores()).toEqual([]);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM store_subscriptions').get()).toEqual({ n: 0 });
    h.failBootstrap = false;
    await expect(insertDoStore(input())).resolves.toBeTruthy();
  });

  it('a bootstrap failure whose ROLLBACK also fails is a P1 alert, never silent', async () => {
    h.failBootstrap = true;
    h.failDelete = true;
    await expect(insertDoStore(input())).rejects.toMatchObject({ code: 'BOOTSTRAP_REFUSED' });
    expect(h.alert).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'p1', source: 'store.create.do_rollback_failed' })
    );
    expect(d1Stores()).toHaveLength(1); // the orphan is exactly what the alert tells the operator to remove
  });

  it('a failure after the insert (chart of accounts) removes the D1 row and its subscription', async () => {
    const id = await insertDoStore(input());
    h.failCoa = true;
    await expect(finishDoStoreCreate(id, { slug: 'nour' })).rejects.toThrow('coa down');
    expect(d1Stores()).toEqual([]);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM store_subscriptions').get()).toEqual({ n: 0 });
  });
});

describe('owner store reads (flag-gated; drift between the backends)', () => {
  const pgStores =
    (...ids: string[]) =>
    async () =>
      ids.map(id => ({ id, createdAt: new Date(1) }));

  it('flag ON: the union of Postgres and D1 by id, counts are the max (a store missing from D1 still counts)', async () => {
    const a = await insertDoStore(input({ slug: 'a1' }));
    await insertDoStore(input({ slug: 'b1', ownerId: 'owner-2' }));
    // pg-001 never reached the D1 directory (failed mirror); `a` has no Postgres row
    const list = await ownerStores('owner-1', pgStores('pg-001'));
    expect(list.map(r => r.id).sort()).toEqual([a, 'pg-001'].sort());
    expect(await countOwnerStores('owner-1', async () => 5)).toBe(5);
    expect(await countOwnerStores('owner-1', async () => 0)).toBe(1);
    expect(
      await countOwnerStoresCreatedSince('owner-1', new Date(Date.now() - 60_000), async () => 3)
    ).toBe(3);
    expect(
      await countOwnerStoresCreatedSince('owner-1', new Date(Date.now() - 60_000), async () => 0)
    ).toBe(1);
  });
  it('flag ON: an unreachable Postgres is "no Postgres stores", D1 still answers', async () => {
    await insertDoStore(input({ slug: 'a1' }));
    const down = async (): Promise<never> => {
      throw new Error('pg down');
    };
    expect((await ownerStores('owner-1', down)).length).toBe(1);
    expect(await countOwnerStores('owner-1', down)).toBe(1);
  });
  it('flag OFF: Postgres only, D1 is never consulted (the drift case: a store missing from Postgres-side counts is unchanged behaviour)', async () => {
    await insertDoStore(input({ slug: 'a1' }));
    process.env.STORE_CREATE_ON_DO = '0';
    expect((await ownerStores('owner-1', pgStores('pg-001'))).map(r => r.id)).toEqual(['pg-001']);
    expect(await countOwnerStores('owner-1', async () => 0)).toBe(0);
    expect(await countOwnerStoresCreatedSince('owner-1', new Date(0), async () => 0)).toBe(0);
  });
});

describe('getEntitlements for a caller that already knows the plan (`known`)', () => {
  it('reads the D1 subscription of a store with no Postgres row (trial, not a derived plan)', async () => {
    const id = await insertDoStore(input({ trial: {} }));
    const { getEntitlements } = await import('../../apps/api/src/services/plan-entitlements');
    const fakeTx = { storeSubscription: { findUnique: async () => null } } as never;
    const e = await getEntitlements(id, fakeTx, { legacyPlan: 'professional' });
    expect(e).toMatchObject({
      status: 'trialing',
      subscribedPlanCode: 'growth',
      derivedFromLegacyPlan: false,
    });
  });
});
