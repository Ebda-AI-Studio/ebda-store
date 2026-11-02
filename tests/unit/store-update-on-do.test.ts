/**
 * Ruling NZ-D8: for a store on its Durable Object the Store write is D1 (directory + mirror) then the DO (profile + config),
 * with Postgres poisoned. Real platform migration + real DO store schema on node:sqlite.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  applyStoreSettings,
  readStoreRecord,
  encodeRpc,
  decodeRpc,
  createD1Client,
} from '@ebda-src/repo';
import { META, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';

const S = '11111111-1111-4111-8111-111111111111';
const T = '22222222-2222-4222-8222-222222222222';
const h = vi.hoisted(() => ({
  d1: null as unknown,
  doDb: null as unknown,
  doCalls: [] as string[],
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
    runInTenantContext: async (_id: string, fn: () => unknown) => fn(),
    onClosedTenantTxAccess: () => undefined,
  };
});
vi.mock('../../apps/api/src/lib/store-backend', () => ({
  backendFor: async () => 'do',
  storeDo: () => ({
    applySettings: async (id: string, json: string) => {
      h.doCalls.push('applySettings');
      return {
        ok: true,
        data: applyStoreSettings(
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
vi.mock('../../apps/api/src/lib/identity-client', () => ({
  getAccountState: async (id: string) => ({ id, email: 'o@x.com', firstName: 'O', lastName: 'W' }),
}));

import { prisma } from '@ebda/database';
import { storeUpdate, storeUpdateMany, storeWritesToDo } from '../../apps/api/src/lib/repo-factory';
import { withDeferredWork } from '../../apps/api/src/lib/after-tenant-commit';

/** The base (non-transaction) client: what a service with no open transaction passes. */
const BASE = prisma as never;
const TX = {} as never; // any other client is a transaction client
import { updateStoreThrough } from '../../apps/api/src/services/store.service';

let sqlite: DatabaseSync;
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
  for (const [id, slug] of [
    [S, 'alpha'],
    [T, 'beta'],
  ])
    sqlite
      .prepare(
        "INSERT INTO stores (id, name, slug, owner_id, storage_backend) VALUES (?,?,?,?, 'do')"
      )
      .run(id, slug, slug, 'owner-1');
  h.d1 = createD1Client(
    META as never,
    {
      prepare: (sql: string) => ({
        bind: (...v: unknown[]) => {
          const run = async () => {
            await Promise.resolve();
            if (/^\s*select/i.test(sql))
              return { results: sqlite.prepare(sql).all(...(v as never[])) };
            return {
              meta: { changes: Number(sqlite.prepare(sql).run(...(v as never[])).changes) },
            };
          };
          return { all: run, run } as never;
        },
      }),
    } as never
  );
  h.doDb = openSqlite();
  for (const [id, slug] of [
    [S, 'alpha'],
    [T, 'beta'],
  ])
    (h.doDb as DatabaseSync)
      .prepare(
        "INSERT INTO store_profile (store_id, name, slug, owner_id) VALUES (?,?,?, 'owner-1')"
      )
      .run(id, slug, slug);
  h.doCalls.length = 0;
});

const d1row = (id: string) =>
  sqlite.prepare('SELECT * FROM stores WHERE id = ?').get(id) as Record<string, unknown>;
const doProfile = (id: string) =>
  (h.doDb as DatabaseSync)
    .prepare('SELECT * FROM store_profile WHERE store_id = ?')
    .get(id) as Record<string, unknown>;

describe('Store write on a Durable Object store (no Postgres)', () => {
  it('writes D1 (mirror) then the DO (profile + config) and returns the merged record', async () => {
    const row = await storeUpdate(BASE, {
      where: { id: S },
      data: {
        name: 'Renamed',
        theme: { a: 1 },
        taxEnabled: true,
        billingSuspendedReason: 'unpaid',
      },
      select: { name: true, theme: true, taxEnabled: true, billingSuspendedReason: true },
    } as never);
    expect(row).toEqual({
      name: 'Renamed',
      theme: { a: 1 },
      taxEnabled: true,
      billingSuspendedReason: 'unpaid',
    });
    expect(d1row(S)).toMatchObject({ name: 'Renamed', billing_suspended_reason: 'unpaid' });
    expect(doProfile(S)).toMatchObject({ name: 'Renamed' });
    expect(JSON.parse(doProfile(S).theme as string)).toEqual({ a: 1 });
  });
  it('a slug taken by another store is refused by D1 first: the DO is untouched', async () => {
    await expect(
      storeUpdate(BASE, { where: { id: S }, data: { slug: 'beta' }, select: { id: true } } as never)
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(h.doCalls).toHaveLength(0);
    expect(doProfile(S).slug).toBe('alpha');
  });
  it('an unknown store is refused before any DO write', async () => {
    await expect(
      storeUpdate(BASE, { where: { id: 'nope' }, data: { name: 'x' } } as never)
    ).rejects.toBeTruthy();
    expect(h.doCalls).toHaveLength(0);
  });
  it('include.owner is read from the identity service, not Postgres', async () => {
    const row: any = await storeUpdate(BASE, {
      where: { id: S },
      data: { name: 'N2' },
      include: { owner: true },
    } as never);
    expect(row.owner).toEqual({ id: 'owner-1', email: 'o@x.com', firstName: 'O', lastName: 'W' });
  });
  it('update operators and relation writes are refused loudly', async () => {
    await expect(
      storeUpdate(BASE, {
        where: { id: S },
        data: { credentials: { upsert: { create: {}, update: {} } } },
      } as never)
    ).rejects.toMatchObject({ statusCode: 501 });
    await expect(
      storeUpdate(BASE, { where: { id: S }, data: { returnWindowDays: { increment: 1 } } } as never)
    ).rejects.toMatchObject({ statusCode: 501 });
  });
  it('updateMany is an atomic compare-and-set on D1; the DO copy follows only when the row matched', async () => {
    const a = await storeUpdateMany(BASE, {
      where: { id: S, status: 'active' },
      data: { status: 'suspended' },
    } as never);
    expect(a.count).toBe(1);
    const b = await storeUpdateMany(BASE, {
      where: { id: S, status: 'active' },
      data: { status: 'suspended' },
    } as never);
    expect(b.count).toBe(0);
    expect(h.doCalls).toHaveLength(1);
    expect(doProfile(S).status).toBe('suspended');
    await expect(
      storeUpdateMany(BASE, {
        where: { id: S, taxEnabled: false },
        data: { status: 'active' },
      } as never)
    ).rejects.toMatchObject({ statusCode: 501 });
  });
  it('updateStoreThrough serves store.update, and any other model is a loud 501', async () => {
    const out = await updateStoreThrough(S, tx =>
      (tx as any).store.update({
        where: { id: S },
        data: { heroTitle: 'Hi' },
        select: { heroTitle: true },
      })
    );
    expect(out).toEqual({ heroTitle: 'Hi' });
    await expect(
      updateStoreThrough(S, async tx => (tx as any).taxRate.create({}))
    ).rejects.toMatchObject({ statusCode: 501 });
  });

  it('writes go to D1 + the DO only when the platform D1 is bound (Node / tests keep the legacy Postgres path)', async () => {
    expect(await storeWritesToDo(S)).toBe(true);
    const bound = h.d1;
    h.d1 = undefined;
    try {
      expect(await storeWritesToDo(S)).toBe(false);
    } finally {
      h.d1 = bound;
    }
  });

  it('NZ-D18: a billing transaction that updates the plan then ROLLS BACK leaves D1 and the DO unchanged', async () => {
    const before = d1row(S).plan;
    await expect(
      withDeferredWork({ storeId: S } as never, async () => {
        const row = await storeUpdate(TX, {
          where: { id: S },
          data: { plan: 'professional' },
          select: { plan: true },
        } as never);
        expect((row as { plan: string }).plan).toBe('professional'); // the caller sees the projected row
        expect(d1row(S).plan).toBe(before); // nothing written inside the transaction
        throw new Error('billing tx rolled back');
      })
    ).rejects.toThrow('rolled back');
    expect(d1row(S).plan).toBe(before);
    expect(h.doCalls).toHaveLength(0);
  });
  it('NZ-D18: the same transaction COMMITTING applies the plan to D1 and the DO after the commit', async () => {
    await withDeferredWork({ storeId: S } as never, async () => {
      await storeUpdate(TX, {
        where: { id: S },
        data: { plan: 'professional' },
        select: { plan: true },
      } as never);
      expect(d1row(S).plan).not.toBe('professional');
    });
    expect(d1row(S).plan).toBe('professional');
    expect(doProfile(S).plan).toBe('professional');
  });
  it('NZ-D18: a transaction client with no post-commit hook, and updateMany on a transaction client, are refused 501', async () => {
    await expect(
      storeUpdate(TX, { where: { id: S }, data: { plan: 'professional' } } as never)
    ).rejects.toMatchObject({ statusCode: 501 });
    await expect(
      storeUpdateMany(TX, {
        where: { id: S, status: 'active' },
        data: { status: 'suspended' },
      } as never)
    ).rejects.toMatchObject({ statusCode: 501 });
    expect(d1row(S).plan).not.toBe('professional');
  });
});
