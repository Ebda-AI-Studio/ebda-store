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
  sendAlert: vi.fn(async () => undefined),
}));

import { setCfBindings, clearCfBindings } from '../../apps/api/src/cf/bindings';
import {
  countOwnerStores,
  countOwnerStoresCreatedSinceD1,
  finishDoStoreCreate,
  insertDoStore,
  listOwnerStoresD1,
  storeCreateOnDo,
  type NewDoStore,
} from '../../apps/api/src/lib/store-create-do';

let sqlite: DatabaseSync;
const fakeD1 = () => ({
  prepare: (sql: string) => ({
    bind: (...v: unknown[]) => {
      const run = async () => {
        await Promise.resolve();
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
  it('writes the D1 row as `do`, bootstraps the DO, the trial subscription in D1, seeds the chart, returns the record', async () => {
    const id = await insertDoStore(input());
    const rec = await finishDoStoreCreate(id, {
      slug: 'nour',
      plan: 'professional',
      trial: {},
    });
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
    // the subscription is a D1 row (the trial: Growth for 14 days, the chosen plan pending)
    expect(
      sqlite.prepare('SELECT plan_code, status FROM store_subscriptions WHERE store_id = ?').all(id)
    ).toEqual([{ plan_code: 'growth', status: 'trialing' }]);
    expect(h.coaCalls).toEqual([id]);
    expect(rec).toMatchObject({ id, name: 'Nour', slug: 'nour', ownerId: 'owner-1' });
  });

  it('a second store for the owner (no trial) rides its plan: active subscription, no trial', async () => {
    const id = await insertDoStore(input({ slug: 'two', plan: 'enterprise' }));
    await finishDoStoreCreate(id, { slug: 'two', plan: 'enterprise' });
    const sub = sqlite
      .prepare(
        'SELECT plan_code, status, trial_ends_at FROM store_subscriptions WHERE store_id = ?'
      )
      .get(id) as Record<string, unknown>;
    expect(sub.status).toBe('active');
    expect(sub.trial_ends_at).toBeNull();
  });

  it('a taken slug is a 409 and nothing reaches the DO', async () => {
    await insertDoStore(input());
    await expect(insertDoStore(input())).rejects.toMatchObject({ statusCode: 409 });
    expect(h.bootstrapCalls).toBe(1);
    expect(d1Stores()).toHaveLength(1);
  });

  it('a DO bootstrap failure removes the D1 row again (nothing resolvable without a bootstrapped DO)', async () => {
    h.failBootstrap = true;
    await expect(insertDoStore(input())).rejects.toMatchObject({ code: 'BOOTSTRAP_REFUSED' });
    expect(d1Stores()).toEqual([]);
    h.failBootstrap = false;
    await expect(insertDoStore(input())).resolves.toBeTruthy(); // the slug is free again
  });

  it('a failure after the insert (chart of accounts) removes the D1 row and its subscription', async () => {
    const id = await insertDoStore(input());
    h.failCoa = true;
    await expect(finishDoStoreCreate(id, { slug: 'nour', plan: 'professional' })).rejects.toThrow(
      'coa down'
    );
    expect(d1Stores()).toEqual([]);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM store_subscriptions').get()).toEqual({ n: 0 });
  });
});

describe('owner store reads come from D1', () => {
  it('lists, counts and counts-since from the directory (soft-deleted excluded from the live list only)', async () => {
    const a = await insertDoStore(input({ slug: 'a1' }));
    await insertDoStore(input({ slug: 'a2' }));
    await insertDoStore(input({ slug: 'b1', ownerId: 'owner-2' }));
    sqlite.prepare('UPDATE stores SET deleted_at = 1 WHERE id = ?').run(a);
    expect((await listOwnerStoresD1('owner-1'))!.length).toBe(1);
    expect(await countOwnerStores('owner-1', async () => 99)).toBe(1);
    expect(await countOwnerStoresCreatedSinceD1('owner-1', new Date(Date.now() - 60_000))).toBe(2);
  });
  it('falls back to the caller (Postgres) only where D1 is unbound', async () => {
    h.d1 = undefined;
    expect(await listOwnerStoresD1('owner-1')).toBeUndefined();
    expect(await countOwnerStores('owner-1', async () => 7)).toBe(7);
    expect(await countOwnerStoresCreatedSinceD1('owner-1', new Date())).toBeUndefined();
  });
});
