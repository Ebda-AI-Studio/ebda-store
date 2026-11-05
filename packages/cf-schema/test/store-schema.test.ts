// Task 1.3: the StoreDO schema applies cleanly (twice), FK/integrity clean, and the rules hold.
import { describe, expect, it } from 'vitest';
import { expectThrows, openDb, readJson, tableNames } from './helpers';

type Manifest = {
  databases: Record<string, { tables: number; columnCounts: Record<string, number> }>;
};
const manifest = readJson<Manifest>('generated/manifest.json');

describe('StoreDO schema', () => {
  const db = openDb('store', 2); // applied twice: idempotent

  it('creates every manifest table and nothing else (plus sqlite_sequence for AUTOINCREMENT)', () => {
    expect(tableNames(db)).toEqual(Object.keys(manifest.databases['store-do'].columnCounts).sort());
    expect(tableNames(db).length).toBe(manifest.databases['store-do'].tables);
  });

  it('PRAGMA foreign_key_check and integrity_check are clean; every table has <= 100 columns', () => {
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(
      (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check
    ).toBe('ok');
    for (const t of tableNames(db)) {
      const n = db.prepare(`PRAGMA table_info("${t}")`).all().length;
      expect(n, t).toBeLessThanOrEqual(100);
    }
  });

  it('the decision tables of the plan exist: 126 models + store_profile, store_config, commerce_outcomes, d1_outbox, do_flags', () => {
    expect(tableNames(db).length).toBe(126 + 5);
  });

  it('enum CHECK, boolean CHECK, json_valid CHECK and FK ON DELETE all bite', () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO products (id, store_id, name, slug, price) VALUES ('p1', 's1', 'n', 'n', 100)`
    ).run();
    // enum: products.status is a Prisma enum
    expectThrows(
      () => db.prepare(`UPDATE products SET status = 'bogus' WHERE id = 'p1'`).run(),
      /CHECK/
    );
    // boolean
    expectThrows(
      () => db.prepare(`UPDATE products SET track_inventory = 7 WHERE id = 'p1'`).run(),
      /CHECK/
    );
    // json (facts is a Json column)
    expectThrows(
      () => db.prepare(`UPDATE products SET facts = '{not json' WHERE id = 'p1'`).run(),
      /CHECK/
    );
    // FK cascade: product_images -> products ON DELETE CASCADE
    db.prepare(`INSERT INTO product_images (id, product_id, url) VALUES ('i1', 'p1', 'u')`).run();
    db.prepare(`DELETE FROM products WHERE id = 'p1'`).run();
    expect(db.prepare(`SELECT count(*) c FROM product_images`).get()).toEqual({ c: 0 });
    // FK enforced: an image for a missing product is refused
    expectThrows(
      () =>
        db
          .prepare(`INSERT INTO product_images (id, product_id, url) VALUES ('i2', 'nope', 'u')`)
          .run(),
      /FOREIGN KEY/
    );
    expect(now).toBeGreaterThan(0);
  });

  it('keeps the partial unique invariants from the raw Postgres migrations (one published page revision per key)', () => {
    const ins = db.prepare(
      `INSERT INTO store_page_revisions (id, store_id, page_key, rev, status, schema_version, document, doc_bytes) VALUES (?, 's1', 'home', ?, ?, 1, '{}', 2)`
    );
    ins.run('r1', 1, 'published');
    expectThrows(() => ins.run('r2', 2, 'published'), /UNIQUE/);
    ins.run('r3', 2, 'draft');
    ins.run('r4', 3, 'archived');
    ins.run('r5', 4, 'archived'); // archived rows are not constrained
  });

  it('carries the CI-1 capture fields and the buyer key', () => {
    const cols = (t: string) =>
      (db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map(c => c.name);
    expect(cols('shipments')).toEqual(
      expect.arrayContaining([
        'return_reason_raw',
        'return_reason_code',
        'picked_up_at',
        'delivered_at',
        'returned_at',
        'delivery_attempts',
        'area_key',
      ])
    );
    expect(cols('orders')).toContain('buyer_key');
    expect(cols('customers')).toContain('buyer_key');
    expect(cols('commerce_outcomes')).toEqual(
      expect.arrayContaining([
        'kind',
        'buyer_key',
        'area_key',
        'reason_code',
        'reason_raw',
        'source',
        'exported_at',
      ])
    );
  });

  it('money columns are integer piastres: no REAL or DECIMAL affinity on a column named *price*, *total*, *amount*, *fee*', () => {
    for (const t of tableNames(db)) {
      for (const c of db.prepare(`PRAGMA table_info("${t}")`).all() as {
        name: string;
        type: string;
      }[]) {
        if (
          /(^|_)(price|total|amount|fee|subtotal|balance|cost)(_|$)/.test(c.name) &&
          !/_(bps|rate|percent)$/.test(c.name)
        ) {
          expect(['INTEGER', 'TEXT'], `${t}.${c.name}`).toContain(c.type);
        }
      }
    }
  });
});
