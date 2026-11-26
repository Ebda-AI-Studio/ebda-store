// INV-AUDIT-3: the CSV import writes a movement row for every stock change (create, update, variant opening stock, variant replace).
import { expect, it } from 'vitest';
import { openSqlite } from './diff-harness';
import { nodeSyncSql } from './node-sync-sql';
import { importProductsBatch, type ImportRowPlan } from '../src/do/catalog-import';

const row = (over: Partial<ImportRowPlan>): ImportRowPlan => ({
  rowIndex: 1,
  existingId: null,
  existingSlug: null,
  slug: 'widget',
  fields: { name: 'Widget', slug: 'widget', price: 1000, inventory: 5 },
  imported: {},
  categoryIds: null,
  tagIds: null,
  imageUrls: null,
  variants: null,
  ...over,
});

it('an import UPDATE that carries inventory writes an adjustment row with the actor; an unchanged value writes none', () => {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  raw.exec(
    `INSERT INTO products (id, store_id, name, slug, price, inventory, status) VALUES ('p1', 's1', 'Widget', 'widget', 1000, 10, 'active')`
  );
  const run = (inventory: number) =>
    importProductsBatch(db, {
      storeId: 's1',
      aiFields: [],
      userId: 'u1',
      rows: [
        row({
          existingId: 'p1',
          existingSlug: 'widget',
          fields: { name: 'Widget', slug: 'widget', price: 1000, inventory },
        }),
      ],
    });
  run(3);
  run(3);
  const rows = raw.prepare('SELECT * FROM inventory_history').all() as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    product_id: 'p1',
    type: 'adjustment',
    quantity: -7,
    previous_stock: 10,
    new_stock: 3,
    created_by: 'u1',
  });
  expect(rows[0].reason).toBeTruthy();
});

it('variant opening stock and a variant replace are recorded', () => {
  const raw = openSqlite();
  const db = nodeSyncSql(raw);
  const variants = (inv: number) => [
    { sku: 'S', option1Name: 'Size', option1Value: 'M', inventory: inv },
  ];
  const first = importProductsBatch(db, {
    storeId: 's1',
    aiFields: [],
    userId: 'u1',
    rows: [row({ variants: variants(6) })],
  });
  const productId = first.products[0].productId;
  importProductsBatch(db, {
    storeId: 's1',
    aiFields: [],
    userId: 'u1',
    rows: [row({ existingId: productId, existingSlug: 'widget', variants: variants(2) })],
  });
  const rows = raw
    .prepare(
      'SELECT type, quantity, previous_stock, new_stock FROM inventory_history ORDER BY rowid'
    )
    .all() as any[];
  // product-level opening (5) + variant opening (6), then replace: -6 for the old variant, +2 for the new one
  expect(rows.map(r => `${r.type}:${r.quantity}`)).toEqual([
    'initial:5',
    'initial:6',
    'adjustment:-6',
    'initial:2',
  ]);
});
