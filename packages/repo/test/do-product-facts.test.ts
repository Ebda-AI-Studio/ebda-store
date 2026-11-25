// Ported from tests/integration/product-facts.test.ts (Postgres): product facts persist as JSON on the real StoreDO schema
// (node:sqlite) through prisma-lite, omitted keys leave them alone, and the schema CHECK refuses a non-array value.
// The 25-row edge limit is covered by tests/unit/commerce-product-facts.test.ts.
import { describe, expect, it } from 'vitest';
import { META, openSqlite } from './diff-harness';
import { createPrismaLite } from '../src/prisma-lite/client';
import { nodeSqlRunner } from './node-sql';

const row = (n: number, onCard = false) => ({
  key: `Key ${n}`,
  keyAr: `مفتاح ${n}`,
  value: `Value ${n}`,
  valueAr: `قيمة ${n}`,
  onCard,
});

function setup() {
  const db = openSqlite();
  const lite = createPrismaLite(META, nodeSqlRunner(db), 'store-do', { unscoped: true }) as any;
  db.prepare(
    `INSERT INTO products (id, store_id, name, slug, price) VALUES ('p1', 's1', 'Linen Abaya', 'linen', 1000)`
  ).run();
  return { db, lite };
}

describe('product facts persistence on the StoreDO schema', () => {
  it('defaults to an empty array', async () => {
    const { lite } = setup();
    const p = await lite.product.findFirst({ where: { id: 'p1' } });
    expect(p.facts).toEqual([]);
  });

  it('an update with 3 rows reads back in order; an update that omits the key leaves them alone', async () => {
    const { lite } = setup();
    const facts = [row(1, true), row(2), row(3)];
    await lite.product.update({ where: { id: 'p1' }, data: { facts } });
    await lite.product.update({ where: { id: 'p1' }, data: { name: 'Linen Abaya 2' } });
    const p = await lite.product.findFirst({ where: { id: 'p1' } });
    expect(p.name).toBe('Linen Abaya 2');
    expect(p.facts).toEqual(facts);
  });

  it('the schema CHECK rejects a non-array facts value (and invalid JSON)', () => {
    const { db } = setup();
    expect(() =>
      db.prepare(`UPDATE products SET facts = '{"a":1}' WHERE id = 'p1'`).run()
    ).toThrow();
    expect(() =>
      db.prepare(`UPDATE products SET facts = 'not json' WHERE id = 'p1'`).run()
    ).toThrow();
  });
});
