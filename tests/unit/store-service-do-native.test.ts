/**
 * N-18 (Rulings NZ-D11, NZ-D14): `StoreService.create` writes D1 + the DO and `StoreService.delete` skips its Postgres phase for a
 * store that has no Postgres row. Postgres is POISONED except the one existence probe `delete` makes (answers null).
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
  closed: [] as string[],
  moneyRefused: false,
  clientsDeleted: [] as string[],
  anonymised: [] as string[],
  paymentsScrubbed: [] as string[],
  pgProbes: 0,
}));

vi.mock('@ebda/database', () => {
  const boom = () => {
    throw new Error('POSTGRES TOUCHED');
  };
  return {
    prisma: new Proxy({}, { get: boom }),
    // `delete`'s only Postgres read for a DO store: "is there a Postgres row?" -> no
    withStore: async (_id: string, fn: (tx: unknown) => unknown) => {
      h.pgProbes++;
      return fn({ store: { findUnique: async () => null } });
    },
    withUser: boom,
    withMoneyTx: boom,
    withSystemJob: boom,
    scopeTransaction: boom,
    asPlatformOperator: boom,
    afterTxCommit: () => false,
    afterTenantTxCommit: () => false,
    runInTenantContext: boom,
    onClosedTenantTxAccess: () => undefined,
    Prisma: {},
  };
});
vi.mock('../../apps/api/src/lib/store-backend', () => ({
  backendFor: async () => 'do',
  storeDo: () => ({
    bootstrapStore: async (id: string, json: string) => ({
      ok: true,
      data: bootstrapStoreRows(
        nodeSqlRunner(h.doDb as DatabaseSync),
        META as never,
        id,
        decodeRpc(json)
      ),
    }),
    storeRecord: async (id: string, fields?: string[]) => {
      const r = readStoreRecord(nodeSqlRunner(h.doDb as DatabaseSync), META as never, id, fields);
      return r
        ? { ok: true, data: { json: encodeRpc(r.record), missing: r.missing } }
        : { ok: false, code: 'STORE_NOT_FOUND', status: 404 };
    },
    // FOLD-ERASURE-2: the post-commit anonymisation of the closed DO
    eraseSubject: async (subj: { storeId: string; kind: string }) => {
      h.anonymised.push(`${subj.kind}:${subj.storeId}`);
      return { erased: {}, remaining: 0 };
    },
    closeIfNoMoneyInFlight: async (id: string) => {
      if (h.moneyRefused) return { ok: true, data: { refused: true, counts: { paidOrders: 1 } } };
      h.closed.push(id);
      return { ok: true, data: { closed: true, token: 't1' } };
    },
  }),
}));
vi.mock('../../apps/api/src/services/billing/payments-erasure', () => ({
  paymentsErasurePort: {
    scrub: async (ids: string[]) => {
      h.paymentsScrubbed.push(...ids);
      return { erased: 0 };
    },
  },
}));
vi.mock('../../apps/api/src/lib/platform-db', () => ({
  requirePlatformDb: async () => h.d1,
  platformDb: async () => h.d1,
}));
vi.mock('../../apps/api/src/services/accounting/account.service', () => ({
  seedCoaForStore: async () => 27,
}));
vi.mock('../../apps/api/src/services/alerts.service', () => ({
  sendAlert: vi.fn(async () => undefined),
}));
vi.mock('../../apps/api/src/services/storage.service', () => ({
  StorageService: {
    deleteByPrefixVerified: async () => ({ deleted: 0, failedKeys: [], remaining: 0 }),
    privateBucket: () => 'private',
  },
}));
vi.mock('../../apps/api/src/lib/identity-client', () => ({
  getAccountState: async () => null,
  deleteStoreClients: async (id: string) => void h.clientsDeleted.push(id),
  isIdentityManagedUser: async () => false,
}));
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: { delete: vi.fn(), get: vi.fn(), set: vi.fn(), acquireLock: vi.fn() },
}));

import { setCfBindings } from '../../apps/api/src/cf/bindings';
import { StoreService } from '../../apps/api/src/services/store.service';

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
  h.closed.length = 0;
  h.anonymised.length = 0;
  h.paymentsScrubbed.length = 0;
  h.clientsDeleted.length = 0;
  h.moneyRefused = false;
  h.pgProbes = 0;
  setCfBindings({ PLATFORM_DB: fakeD1(), STORE_DO: {} } as never);
  process.env.STORE_CREATE_ON_DO = '1';
});

describe('StoreService.create on D1 + DO', () => {
  it('a merchant first store: inactive, Professional, on the Growth trial, in D1 + the DO, no Postgres', async () => {
    const store = (await StoreService.create('owner-1', { name: 'Nour Shop' } as never)) as Record<
      string,
      any
    >;
    expect(store).toMatchObject({ name: 'Nour Shop', status: 'inactive', plan: 'professional' });
    expect(store.owner).toEqual({ id: 'owner-1' });
    const row = sqlite.prepare('SELECT slug, storage_backend FROM stores WHERE id=?').get(store.id);
    expect(row).toEqual({ slug: 'nour-shop', storage_backend: 'do' });
    expect(
      sqlite.prepare('SELECT status FROM store_subscriptions WHERE store_id=?').get(store.id)
    ).toEqual({ status: 'trialing' });
    // the name-derived slug is de-duplicated against D1 for the next store of the same name
    const again = (await StoreService.create('owner-2', { name: 'Nour Shop' } as never)) as Record<
      string,
      any
    >;
    expect(sqlite.prepare('SELECT slug FROM stores WHERE id=?').get(again.id)).toEqual({
      slug: 'nour-shop-1',
    });
  });
});

describe('StoreService.delete of a store with no Postgres row (NZ-D14)', () => {
  it('closes the DO, skips every Postgres delete, marks the D1 row deleted, removes integrator clients', async () => {
    const store = (await StoreService.create('owner-1', { name: 'Gone Shop' } as never)) as Record<
      string,
      any
    >;
    const out = await StoreService.delete(store.id);
    expect(out).toEqual({ id: store.id, name: 'Gone Shop', slug: 'gone-shop' });
    expect(h.closed).toEqual([store.id]);
    expect(h.clientsDeleted).toEqual([store.id]);
    // PDPL: the closed DO is anonymised, the platform payer fields scrubbed (FOLD-ERASURE-2)
    expect(h.anonymised).toEqual([`merchant:${store.id}`]);
    expect(h.paymentsScrubbed).toEqual([store.id]);
    expect(h.pgProbes).toBe(1); // only the existence probe
    expect(
      sqlite.prepare('SELECT status, deleted_at FROM stores WHERE id=?').get(store.id)
    ).toMatchObject({ status: 'inactive' });
    expect(
      (sqlite.prepare('SELECT deleted_at FROM stores WHERE id=?').get(store.id) as any).deleted_at
    ).not.toBeNull();
  });
  it('money in flight still refuses the delete (409) and touches nothing', async () => {
    const store = (await StoreService.create('owner-1', { name: 'Busy Shop' } as never)) as Record<
      string,
      any
    >;
    h.moneyRefused = true;
    await expect(StoreService.delete(store.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'STORE_HAS_MONEY_IN_FLIGHT',
    });
    expect(
      (sqlite.prepare('SELECT deleted_at FROM stores WHERE id=?').get(store.id) as any).deleted_at
    ).toBeNull();
  });
});
