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
const realHooks = vi.hoisted(() => ({
  afterTxCommit: (_tx: object, _fn: () => unknown): boolean => false,
}));
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
    afterTxCommit: (tx: object, fn: () => unknown) => realHooks.afterTxCommit(tx, fn),
    afterTenantTxCommit: (fn: () => unknown) =>
      realHooks.ambient ? (realHooks.ambient.push(fn), true) : false,
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
vi.mock('../../apps/api/src/services/alerts.service', () => ({
  sendAlert: vi.fn(async () => undefined),
}));
vi.mock('../../apps/api/src/lib/identity-client', () => ({
  getAccountState: async (id: string) => ({ id, email: 'o@x.com', firstName: 'O', lastName: 'W' }),
}));

import { prisma } from '@ebda/database';
import { setCfBindings, clearCfBindings } from '../../apps/api/src/cf/bindings';
import { applyStoreUpdateRetry } from '../../apps/api/src/lib/store-update-retry';
import { storeUpdate, storeUpdateMany, storeWritesToDo } from '../../apps/api/src/lib/repo-factory';
import { afterTxCommit, runCommitHooks } from '../../packages/database/src/tx-hooks';
import { withMoneyTx } from '../../packages/database/src/with-money-tx';

realHooks.afterTxCommit = afterTxCommit;
/** A fake Prisma whose $transaction runs the callback with a fresh tx object and COMMITS unless it throws. */
const fakePrisma = {
  $transaction: async (cb: (tx: object) => unknown) => cb({ id: Math.random() }),
} as never;

/** The base (non-transaction) client: what a service with no open transaction passes. */
const BASE = prisma as never;
const NO_HOOKS = {} as never; // a transaction client with no hook registry
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
            if (realHooks.failD1Writes > 0) {
              realHooks.failD1Writes--;
              throw new Error('d1 down');
            }
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
  realHooks.ambient = null;
  realHooks.failD1Writes = 0;
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

  it('NZ-D18/19: a billing transaction that updates the plan then ROLLS BACK leaves D1 and the DO unchanged', async () => {
    const before = d1row(S).plan;
    await expect(
      withMoneyTx(fakePrisma, async tx => {
        const row = await storeUpdate(
          tx as never,
          { where: { id: S }, data: { plan: 'professional' }, select: { plan: true } } as never
        );
        expect((row as { plan: string }).plan).toBe('professional'); // the caller sees the projected row
        expect(d1row(S).plan).toBe(before); // nothing written inside the transaction
        throw new Error('billing tx rolled back');
      })
    ).rejects.toThrow('rolled back');
    expect(d1row(S).plan).toBe(before);
    expect(h.doCalls).toHaveLength(0);
  });
  it('NZ-D18/19: the same transaction COMMITTING applies the plan to D1 and the DO after the commit', async () => {
    await withMoneyTx(fakePrisma, async tx => {
      await storeUpdate(
        tx as never,
        { where: { id: S }, data: { plan: 'professional' }, select: { plan: true } } as never
      );
      expect(d1row(S).plan).not.toBe('professional');
    });
    expect(d1row(S).plan).toBe('professional');
    expect(doProfile(S).plan).toBe('professional');
  });
  it('NZ-D19: a money tx that ROLLS BACK while the OUTER transaction commits writes nothing (the hook belongs to the tx it was given)', async () => {
    const before = d1row(S).plan;
    await withMoneyTx(fakePrisma, async outer => {
      void outer; // the outer scope commits
      await expect(
        withMoneyTx(fakePrisma, async inner => {
          await storeUpdate(
            inner as never,
            { where: { id: S }, data: { plan: 'professional' }, select: { plan: true } } as never
          );
          throw new Error('money tx rolled back');
        })
      ).rejects.toThrow('money tx rolled back');
    });
    expect(d1row(S).plan).toBe(before);
    expect(h.doCalls).toHaveLength(0);
  });
  it('NZ-D19: a transaction client with no hook registry, and updateMany on a transaction client, are refused 501', async () => {
    await expect(
      storeUpdate(NO_HOOKS, { where: { id: S }, data: { plan: 'professional' } } as never)
    ).rejects.toMatchObject({ statusCode: 501 });
    await expect(
      storeUpdateMany(NO_HOOKS, {
        where: { id: S, status: 'active' },
        data: { status: 'suspended' },
      } as never)
    ).rejects.toMatchObject({ statusCode: 501 });
    expect(d1row(S).plan).not.toBe('professional');
  });

  describe('entitlement changes through the base client (withStore callers) follow the AMBIENT transaction (NZ-D19)', () => {
    const run = async (commit: boolean, patch: Record<string, unknown>) => {
      const ambient: Array<() => unknown> = [];
      realHooks.ambient = ambient;
      await storeUpdate(BASE, {
        where: { id: S },
        data: patch,
        select: { plan: true, theme: true },
      } as never);
      if (commit) await runCommitHooks(ambient);
      realHooks.ambient = null;
    };
    it('plan changed in an ambient tx that ROLLS BACK: nothing written; COMMITS: written after the commit', async () => {
      const before = d1row(S).plan;
      await run(false, { plan: 'professional' });
      expect(d1row(S).plan).toBe(before);
      await run(true, { plan: 'professional' });
      expect(d1row(S).plan).toBe('professional');
      expect(doProfile(S).plan).toBe('professional');
    });
    it('a non-entitlement field, and a write with no ambient transaction, are applied immediately', async () => {
      await run(false, { theme: { a: 1 } });
      expect(JSON.parse(doProfile(S).theme as string)).toEqual({ a: 1 });
      await storeUpdate(BASE, {
        where: { id: S },
        data: { plan: 'enterprise' },
        select: { plan: true },
      } as never);
      expect(d1row(S).plan).toBe('enterprise');
    });
    it('a post-commit D1 failure is ALERTED, a retry is queued, and the retry converges (D1 and the DO match)', async () => {
      const sent: unknown[] = [];
      setCfBindings({ JOBS_QUEUE: { send: async (m: unknown) => void sent.push(m) } } as never);
      const { sendAlert } = await import('../../apps/api/src/services/alerts.service');
      (sendAlert as ReturnType<typeof vi.fn>).mockClear();
      const ambient: Array<() => unknown> = [];
      realHooks.ambient = ambient;
      await storeUpdate(BASE, {
        where: { id: S },
        data: { plan: 'professional' },
        select: { plan: true },
      } as never);
      realHooks.failD1Writes = 1; // the post-commit write hits a D1 outage
      await runCommitHooks(ambient);
      realHooks.ambient = null;
      expect(d1row(S).plan).not.toBe('professional');
      expect(sendAlert).toHaveBeenCalledTimes(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        kind: 'store-update-retry',
        storeId: S,
        data: { plan: 'professional' },
        version: expect.any(Number),
      });
      // the queue redelivers: D1 is back, the retry applies it
      const { storeUpdateVersioned } = await import('../../apps/api/src/lib/repo-factory');
      const out = await applyStoreUpdateRetry(sent[0] as never, { apply: storeUpdateVersioned });
      expect(out).toBe('done');
      expect(d1row(S).plan).toBe('professional');
      expect(doProfile(S).plan).toBe('professional');
      clearCfBindings();
    });

    it('commit A (v5) fails -> commit B (v6) succeeds -> the retry of A arrives -> SKIPPED; D1 and the DO stay at B', async () => {
      const { storeUpdateVersioned } = await import('../../apps/api/src/lib/repo-factory');
      sqlite.prepare('UPDATE stores SET updated_at = 1 WHERE id = ?').run(S); // the row's last write is older than v5
      // A (v5) failed earlier and is queued; B (v6) lands
      expect(await storeUpdateVersioned(S, { plan: 'enterprise' }, 6)).toBe('applied');
      expect(d1row(S).plan).toBe('enterprise');
      expect(d1row(S).updated_at).toBe(6);
      // the stale retry of A (v5, plan professional) arrives: skipped, nothing changes
      const out = await applyStoreUpdateRetry(
        { kind: 'store-update-retry', storeId: S, data: { plan: 'professional' }, version: 5 },
        { apply: storeUpdateVersioned }
      );
      expect(out).toBe('done');
      expect(d1row(S).plan).toBe('enterprise');
      expect(d1row(S).updated_at).toBe(6);
      expect(doProfile(S).plan).toBe('enterprise');
    });
    it('an EQUAL version is the same write: D1 is untouched and the DO side is re-copied (>= skips the D1 write)', async () => {
      const { storeUpdateVersioned } = await import('../../apps/api/src/lib/repo-factory');
      sqlite.prepare('UPDATE stores SET updated_at = 1 WHERE id = ?').run(S);
      await storeUpdateVersioned(S, { plan: 'professional' }, 10);
      (h.doDb as DatabaseSync)
        .prepare("UPDATE store_profile SET plan = 'starter' WHERE store_id = ?")
        .run(S); // the DO copy was the part that failed
      h.doCalls.length = 0;
      expect(await storeUpdateVersioned(S, { plan: 'professional' }, 10)).toBe('applied');
      expect(h.doCalls).toEqual(['applySettings']);
      expect(doProfile(S).plan).toBe('professional');
      expect(d1row(S).updated_at).toBe(10);
    });
  });
});
