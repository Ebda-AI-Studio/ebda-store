/**
 * Ruling NZ-D14: deleting a store removes it from the D1 directory (every backend) and wipes its Durable Object (a `do` store), so it
 * stops resolving and stops being served; a step that keeps failing is a P1 alert, never silent.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setCfBindings, clearCfBindings } from '../../apps/api/src/cf/bindings';

const state = vi.hoisted(() => ({
  erased: [] as Array<Record<string, unknown>>,
  remaining: 0,
  failErase: false,
}));
vi.mock('@ebda/database', () => ({ prisma: {}, withStore: async () => null }));
vi.mock('../../apps/api/src/lib/store-backend', () => ({
  backendFor: async () => 'do',
  storeDo: () => ({}),
}));
vi.mock('../../apps/api/src/services/alerts.service', () => ({
  sendAlert: vi.fn(async () => undefined),
}));

import { lookupStore } from '../../apps/api/src/lib/definer';
import { finishStoreDeletion } from '../../apps/api/src/lib/store-delete-post-commit';
import { assertNoMoneyInFlightOnDo } from '../../apps/api/src/services/store-closure.service';

const A = '11111111-1111-4111-8111-111111111111';
let sqlite: DatabaseSync;
let failD1 = 0;
const d1 = () => ({
  prepare: (sql: string) => ({
    bind: (...v: unknown[]) => {
      const run = async () => {
        await Promise.resolve();
        if (failD1 > 0 && /^\s*delete/i.test(sql)) {
          failD1--;
          throw new Error('d1 down');
        }
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
  sqlite
    .prepare(
      "INSERT INTO stores (id, name, slug, owner_id, storage_backend) VALUES (?, 'A', 'alpha', 'o1', 'do')"
    )
    .run(A);
  sqlite.prepare("INSERT INTO store_staff (id, store_id, user_id) VALUES ('m1', ?, 'u1')").run(A);
  state.erased.length = 0;
  state.remaining = 0;
  state.failErase = false;
  failD1 = 0;
  setCfBindings({ PLATFORM_DB: d1() } as never);
});

const row = () =>
  sqlite.prepare('SELECT status, deleted_at FROM stores WHERE id=?').get(A) as
    | { status: string; deleted_at: number | null }
    | undefined;

describe('finishStoreDeletion (Ruling NZ-D15: never wipes a DO)', () => {
  it('a do store: the D1 row is MARKED deleted (kept), it stops resolving, and the StoreDO is CLOSED', async () => {
    expect(await lookupStore({ slug: 'alpha' })).toEqual({ id: A, status: 'active' });
    const closed: string[] = [];
    const r = await finishStoreDeletion(
      { storeId: A, wasOnDo: true },
      { closeDo: async id => void closed.push(id) }
    );
    expect(r).toEqual({ directory: true, closed: true });
    expect(await lookupStore({ slug: 'alpha' })).toBeNull();
    expect(await lookupStore({ id: A }, ['active', 'inactive', 'suspended'])).toBeNull();
    expect(row()?.deleted_at).not.toBeNull(); // retained, not removed
    expect(row()?.status).toBe('inactive');
    expect(
      sqlite.prepare('SELECT COUNT(*) n FROM store_staff WHERE store_id=?').get(A)
    ).toMatchObject({ n: 1 });
    expect(closed).toEqual([A]);
  });
  it('a Postgres store (already hard-deleted there): the D1 row is removed, no DO call', async () => {
    const closed: string[] = [];
    const r = await finishStoreDeletion(
      { storeId: A, wasOnDo: false },
      { closeDo: async id => void closed.push(id) }
    );
    expect(r).toEqual({ directory: true, closed: null });
    expect(closed).toEqual([]);
    expect(row()).toBeUndefined();
  });
  it('a D1 failure is retried, and a persistent one is a P1 alert (the store would keep resolving)', async () => {
    const alert = vi.fn();
    failD1 = 2;
    expect((await finishStoreDeletion({ storeId: A, wasOnDo: false }, { alert })).directory).toBe(
      true
    );
    expect(alert).not.toHaveBeenCalled();
    sqlite
      .prepare("INSERT INTO stores (id, name, slug, owner_id) VALUES ('b','B','beta','o')")
      .run();
    failD1 = 99;
    expect((await finishStoreDeletion({ storeId: 'b', wasOnDo: false }, { alert })).directory).toBe(
      false
    );
    expect(alert).toHaveBeenCalledTimes(1);
  });
  it('a DO that will not close is retried then alerted', async () => {
    const alert = vi.fn();
    const closeDo = vi.fn(async () => {
      throw new Error('do down');
    });
    const r = await finishStoreDeletion({ storeId: A, wasOnDo: true }, { alert, closeDo });
    expect(r.closed).toBe(false);
    expect(closeDo).toHaveBeenCalledTimes(3);
    expect(alert).toHaveBeenCalledTimes(1);
  });
  it('a deleted DO store leaves the DO job list (deleted_at IS NULL) but its row remains', async () => {
    await finishStoreDeletion({ storeId: A, wasOnDo: true }, { closeDo: async () => undefined });
    expect(fs.readFileSync('apps/api/src/lib/store-backend.ts', 'utf8')).toContain(
      "storage_backend = 'do' AND deleted_at IS NULL"
    );
    expect(
      sqlite
        .prepare("SELECT id FROM stores WHERE storage_backend='do' AND deleted_at IS NULL")
        .all()
    ).toEqual([]);
  });
});

describe('money in flight is read from the DO (Ruling NZ-D15)', () => {
  it('any money in flight refuses the deletion with 409 and the counts', async () => {
    await expect(
      assertNoMoneyInFlightOnDo(A, async () => ({ paidUndelivered: 1, walletBalances: 0 }))
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'STORE_HAS_MONEY_IN_FLIGHT',
    });
  });
  it('a clean DO passes', async () => {
    await expect(
      assertNoMoneyInFlightOnDo(A, async () => ({ paidUndelivered: 0, walletBalances: 0 }))
    ).resolves.toBeUndefined();
  });
});

describe('no code path wipes a DO on delete', () => {
  const read = (f: string) => fs.readFileSync(f, 'utf8');
  it('StoreService.delete checks the DO BEFORE the Postgres transaction and finishes AFTER it', () => {
    const src = read('apps/api/src/services/store.service.ts');
    const del = src.slice(src.indexOf('static async delete('));
    const check = del.indexOf('assertNoMoneyInFlightOnDo(storeId');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(del.indexOf('withMoneyTx'));
    expect(del.indexOf('finishStoreDeletion(')).toBeGreaterThan(del.indexOf('withMoneyTx'));
  });
  it('the delete flow never calls deleteAll / eraseSubject / a teardown', () => {
    for (const f of [
      'apps/api/src/lib/store-delete-post-commit.ts',
      'apps/api/src/services/store-closure.service.ts',
    ]) {
      const t = read(f);
      expect(t, f).not.toMatch(/deleteAll|eraseSubject|tearDown|__unseal/);
    }
    const del = read('apps/api/src/services/store.service.ts');
    const body = del.slice(
      del.indexOf('static async delete('),
      del.indexOf('static async delete(') + 12000
    );
    expect(body).not.toMatch(/deleteAll|eraseSubject|tearDown/);
  });
  it('the StoreDO closes with one flag and exposes no wipe for it', () => {
    const t = read('packages/repo/src/do/closure.ts');
    expect(t).not.toMatch(/deleteAll|DELETE FROM|DROP TABLE/);
  });
});
