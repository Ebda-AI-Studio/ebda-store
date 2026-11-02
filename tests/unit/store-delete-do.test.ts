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

describe('finishStoreDeletion (Rulings NZ-D15, NZ-D17)', () => {
  it('a do store: the D1 row is MARKED deleted (kept) and stops resolving; staff rows stay', async () => {
    expect(await lookupStore({ slug: 'alpha' })).toEqual({ id: A, status: 'active' });
    const r = await finishStoreDeletion({ storeId: A, wasOnDo: true });
    expect(r).toEqual({ directory: true });
    expect(await lookupStore({ slug: 'alpha' })).toBeNull();
    expect(await lookupStore({ id: A }, ['active', 'inactive', 'suspended'])).toBeNull();
    expect(row()?.deleted_at).not.toBeNull();
    expect(row()?.status).toBe('inactive');
    expect(
      sqlite.prepare('SELECT COUNT(*) n FROM store_staff WHERE store_id=?').get(A)
    ).toMatchObject({ n: 1 });
  });
  it('a Postgres store (already hard-deleted there): the D1 row is removed', async () => {
    expect(await finishStoreDeletion({ storeId: A, wasOnDo: false })).toEqual({ directory: true });
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
  it('a deleted DO store leaves the DO job list (deleted_at IS NULL) but its row remains', async () => {
    await finishStoreDeletion({ storeId: A, wasOnDo: true });
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

describe('the atomic close wrappers (Ruling NZ-D17)', () => {
  const stubWith = (answer: unknown) => ({ closeIfNoMoneyInFlight: async () => answer });
  it('refused -> 409 STORE_HAS_MONEY_IN_FLIGHT with the counts; closed -> transitioned flag', async () => {
    vi.resetModules();
    vi.doMock('../../apps/api/src/lib/store-backend', () => ({
      backendFor: async () => 'do',
      storeDo: () =>
        stubWith({ ok: true, data: { refused: true, counts: { paidUndelivered: 2 } } }),
    }));
    const a = await import('../../apps/api/src/lib/repo-factory');
    await expect(a.closeDoIfNoMoney(A)).rejects.toMatchObject({
      statusCode: 409,
      code: 'STORE_HAS_MONEY_IN_FLIGHT',
    });
    vi.resetModules();
    vi.doMock('../../apps/api/src/lib/store-backend', () => ({
      backendFor: async () => 'do',
      storeDo: () => stubWith({ ok: true, data: { closed: true, transitioned: true } }),
    }));
    const b = await import('../../apps/api/src/lib/repo-factory');
    await expect(b.closeDoIfNoMoney(A)).resolves.toEqual({ transitioned: true });
    vi.doUnmock('../../apps/api/src/lib/store-backend');
  });
});

describe('StoreService.delete ordering and no wipe (static)', () => {
  const read = (f: string) => fs.readFileSync(f, 'utf8');
  const del = () => {
    const src = read('apps/api/src/services/store.service.ts');
    return src.slice(src.indexOf('static async delete('));
  };
  it('closes the DO FIRST (after the billing-parent refusal), before the Postgres transaction; reopens in the catch; finishes after', () => {
    const d = del();
    const close = d.indexOf('closeDoIfNoMoney(storeId)');
    expect(close).toBeGreaterThan(d.indexOf('STORE_IS_BILLING_PARENT'));
    expect(close).toBeLessThan(d.indexOf('withMoneyTx'));
    expect(d.indexOf('reopenDoAfterFailedDelete(storeId)')).toBeGreaterThan(
      d.indexOf('withMoneyTx')
    );
    expect(d.indexOf('reopenDoAfterFailedDelete(storeId)')).toBeLessThan(
      d.indexOf('finishStoreDeletion(')
    );
    expect(d.indexOf('finishStoreDeletion(')).toBeGreaterThan(d.indexOf('withMoneyTx'));
  });
  it('the delete flow never calls deleteAll / eraseSubject / a teardown', () => {
    for (const f of [
      'apps/api/src/lib/store-delete-post-commit.ts',
      'apps/api/src/services/store-closure.service.ts',
    ])
      expect(read(f), f).not.toMatch(/deleteAll|eraseSubject|tearDown|__unseal/);
    expect(del().slice(0, 14000)).not.toMatch(/deleteAll|eraseSubject|tearDown/);
  });
  it('the closure module deletes no store data (only its own flag rows)', () => {
    const t = read('packages/repo/src/do/closure.ts');
    expect(t).not.toMatch(/deleteAll|DROP TABLE/);
    expect([...t.matchAll(/DELETE FROM (\w+)/g)].map(m => m[1])).toEqual(['do_flags']);
  });
});
