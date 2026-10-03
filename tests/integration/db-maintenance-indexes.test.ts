/**
 * DB maintenance migrations (index audit 2026-10, approved 2026-10-03):
 *   - 20261003110000_enable_pg_stat_statements
 *   - 20261003110100_drop_redundant_prefix_indexes
 *
 * Pinned here, against a database built by `prisma migrate deploy`:
 *   - the eight redundant prefix indexes are gone, each with a valid covering
 *     index still in place, and `product_variants_sku_idx` (the one candidate
 *     that is NOT redundant, Ruling DBM-2) is kept;
 *   - every foreign key still has an index leading on its columns;
 *   - the drop is GUARDED: re-running the migration SQL where a covering index is
 *     missing keeps the short index (so a drifted database can never end up with
 *     neither). Run in a transaction that is rolled back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '@force/database';
import { hasDb } from '../helpers/bundle-fixtures';

const migrationsDir = join(__dirname, '../../packages/database/prisma/migrations');
const dropSql = readFileSync(
  join(migrationsDir, '20261003110100_drop_redundant_prefix_indexes/migration.sql'),
  'utf8'
);

/** [dropped index, the longer index that keeps serving it] */
const REDUNDANT: Array<[string, string]> = [
  ['carts_store_id_idx', 'carts_store_id_session_id_key'],
  [
    'ai_recommendation_store_id_source_product_id_idx',
    'ai_recommendation_store_id_source_product_id_target_product_id_',
  ],
  ['audit_logs_store_id_idx', 'audit_logs_store_id_created_at_idx'],
  ['orders_store_id_idx', 'orders_store_id_created_at_idx'],
  ['products_store_id_idx', 'products_store_id_status_idx'],
  ['payment_events_event_type_idx', 'payment_events_event_type_occurred_at_idx'],
  ['inventory_history_store_id_idx', 'inventory_history_store_id_reference_idx'],
  ['cart_bundles_cart_id_idx', 'cart_bundles_cart_id_bundle_id_key'],
];

async function present(names: string[]): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
    SELECT i.indexrelid::regclass::text AS indexname
    FROM pg_index i
    WHERE i.indisvalid AND i.indexrelid::regclass::text = ANY(${names})
  `;
  return rows.map(r => r.indexname).sort();
}

describe.skipIf(!hasDb)('db maintenance: redundant prefix indexes', () => {
  it('the eight redundant indexes are gone and every covering index is valid', async () => {
    expect(await present(REDUNDANT.map(([r]) => r))).toEqual([]);
    expect(await present(REDUNDANT.map(([, c]) => c))).toEqual(REDUNDANT.map(([, c]) => c).sort());
  });

  it('keeps product_variants_sku_idx: nothing longer serves a sku lookup', async () => {
    expect(await present(['product_variants_sku_idx'])).toEqual(['product_variants_sku_idx']);
  });

  it('every foreign key still has an index leading on its columns', async () => {
    const rows = await prisma.$queryRaw<Array<{ conrelid: string; conname: string }>>`
      SELECT c.conrelid::regclass::text AS conrelid, c.conname
      FROM pg_constraint c
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
        AND NOT EXISTS (
          SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indisvalid
            AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey
            AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] <@ c.conkey)
    `;
    expect(rows).toEqual([]);
  });

  it('the drop is guarded: with a covering index missing, the short index is kept', async () => {
    const ROLLBACK = new Error('rollback');
    let keptOrders: string[] = [];
    let keptCarts: string[] = [];
    await prisma
      .$transaction(async tx => {
        // Put the world back as it was before the migration, minus one covering index.
        await tx.$executeRawUnsafe(`CREATE INDEX "orders_store_id_idx" ON "orders" ("store_id")`);
        await tx.$executeRawUnsafe(`CREATE INDEX "carts_store_id_idx" ON "carts" ("store_id")`);
        await tx.$executeRawUnsafe(`DROP INDEX "orders_store_id_created_at_idx"`);
        await tx.$executeRawUnsafe(dropSql);
        const rows = await tx.$queryRaw<Array<{ indexname: string }>>`
          SELECT indexname FROM pg_indexes
          WHERE indexname IN ('orders_store_id_idx', 'carts_store_id_idx')`;
        keptOrders = rows.map(r => r.indexname).filter(n => n === 'orders_store_id_idx');
        keptCarts = rows.map(r => r.indexname).filter(n => n === 'carts_store_id_idx');
        throw ROLLBACK;
      })
      .catch(e => {
        if (e !== ROLLBACK) throw e;
      });
    expect(keptOrders).toEqual(['orders_store_id_idx']); // its covering index was gone
    expect(keptCarts).toEqual([]); // its covering index was there, so it was dropped
    // and the rollback really restored the database
    expect(await present(['orders_store_id_created_at_idx'])).toEqual([
      'orders_store_id_created_at_idx',
    ]);
    expect(await present(['orders_store_id_idx', 'carts_store_id_idx'])).toEqual([]);
  });
});
