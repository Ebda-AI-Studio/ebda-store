/**
 * M-107 follow-up: N simultaneous creates of the same (store, product, NULL variant) leave exactly one rule. A NULL
 * `variant_id` is distinct in a plain unique index and a pre-check alone is check-then-insert, so this runs the REAL service
 * over the REAL StoreDO schema (0001 + prisma-lite on node:sqlite), with every storeDb / storeWriter call yielding to the
 * event loop first so the creates really interleave. The in-memory fake in reorder-rules-route.test.ts cannot show this.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { createPrismaLite } from '../../packages/repo/src/prisma-lite/client';
import { META, openSqlite, insertSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';

const STORE = 'store-a';
const holder = vi.hoisted(() => ({ lite: null as any }));

// Every delegate call yields first: the pre-check of every concurrent create runs before any insert.
const yielding = new Proxy(
  {},
  {
    get: (_t, model: string) =>
      new Proxy(
        {},
        {
          get:
            (_m, op: string) =>
            async (...args: unknown[]) => {
              await new Promise(r => setImmediate(r));
              return holder.lite[model][op](...args);
            },
        }
      ),
  }
);
vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeDb: async () => yielding,
  storeWriter: async () => yielding,
}));

import { createReorderRule } from '../../apps/api/src/services/accounting/reorder-rule.service';

function world() {
  const db = openSqlite();
  holder.lite = createPrismaLite(META as never, nodeSqlRunner(db), 'store-do', {
    storeId: STORE,
  }) as never;
  insertSqlite(db, 'Product', [{ id: 'p1', storeId: STORE, name: 'Tee', slug: 'tee', price: 100 }]);
  return db;
}
const rows = (db: ReturnType<typeof openSqlite>) =>
  db.prepare('SELECT id FROM reorder_rules').all().length;

describe('reorder rule create under concurrency (real DO schema)', () => {
  it('8 simultaneous creates for the same (product, null variant): one row, one winner, seven 409s', async () => {
    const db = world();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        createReorderRule(STORE, { productId: 'p1', minQty: 5, reorderQty: 20 })
      )
    );
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
    expect(lost).toHaveLength(7);
    for (const l of lost)
      expect(l.reason).toMatchObject({ statusCode: 409, code: 'REORDER_RULE_EXISTS' });
    expect(rows(db)).toBe(1);
  });

  it('cf-0005 on a DO that already holds duplicate product-level rules keeps the newest per item', () => {
    const db = openSqlite();
    // a DO from before the index: drop it (0001 now creates it) and seed duplicates
    db.exec('DROP INDEX reorder_rules_one_per_item');
    insertSqlite(db, 'Product', [
      { id: 'p1', storeId: STORE, name: 'Tee', slug: 'tee', price: 100 },
      { id: 'p2', storeId: STORE, name: 'Cap', slug: 'cap', price: 100 },
    ]);
    const ins = db.prepare(
      `INSERT INTO reorder_rules (id, store_id, product_id, variant_id, min_qty, reorder_qty, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 1, 1, ?, ?)`
    );
    ins.run('old', STORE, 'p1', 1000, 1000);
    ins.run('new', STORE, 'p1', 2000, 2000);
    ins.run('other', STORE, 'p2', 1500, 1500);
    db.exec(
      fs.readFileSync(
        path.resolve(
          __dirname,
          '../../packages/cf-schema/migrations/store/0005_reorder_rules_one_per_item.sql'
        ),
        'utf8'
      )
    );
    expect(db.prepare('SELECT id FROM reorder_rules ORDER BY id').all()).toEqual([
      { id: 'new' },
      { id: 'other' },
    ]);
    expect(() => ins.run('dup', STORE, 'p1', 3000, 3000)).toThrow(/UNIQUE/);
  });
});
