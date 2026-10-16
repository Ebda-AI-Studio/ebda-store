/**
 * Task 14 (load test) finding: the normalised-LIKE product search never used its trigram indexes
 * under the strict-RLS role `ebda_app`. The planner tests ran as the owner (BYPASSRLS); under RLS
 * the policy qual is a security barrier and a user qual may only be evaluated before it (so only
 * be an index condition) when its functions are LEAKPROOF. btrim / regexp_replace / translate /
 * texticlike are not, so every storefront, typeahead and admin search became a store_id scan that
 * normalised every product row of the store (measured: 80 ms at 2 000 products, 740 ms at
 * 20 000, single query, idle machine). The fix is the SECURITY DEFINER `ebda_product_search_ids`
 * (migration 20261024000300), which finds the candidate ids with the indexes and leaves status /
 * soft-delete / ordering to the RLS-protected outer query.
 *
 * Evidence here is the index's own scan counter, read after running the production statements as
 * `ebda_app` under a store scope: a Seq Scan leaves it at 0. (A plan from EXPLAIN would not show
 * the inner statement of a function.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { prisma, createPrismaClient, runWithRequestDb, runInTenantContext } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';

const { searchProductIds } = await import('../../apps/api/src/services/product-search.service');

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
  return u.toString();
}
// ONE connection: the stats flush below must happen in the session that ran the searches.
const app = hasDb ? createPrismaClient({ connectionString: appUrl(), max: 1 }) : null;
const asApp = <T>(fn: () => Promise<T>) => runWithRequestDb(() => app!, fn);

const ROWS = 20_000;
const tag = `lx${Date.now()}${crypto.randomBytes(2).toString('hex')}`;
let storeId = '';
let ownerId = '';
const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');

async function idxScans(name: string): Promise<number> {
  await prisma.$queryRaw`SELECT pg_stat_clear_snapshot()`;
  const r = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT idx_scan AS n FROM pg_stat_user_indexes WHERE indexrelname = ${name}`;
  return Number(r[0].n);
}
async function flushAppStats() {
  await asApp(() => app!.$queryRaw`SELECT pg_stat_force_next_flush()`);
  await new Promise(r => setTimeout(r, 50));
}

describe.skipIf(!hasDb)(
  'lexical product search uses its trigram indexes under RLS (Task 14)',
  () => {
    beforeAll(async () => {
      const owner = await prisma.user.create({
        data: {
          email: `${tag}@x.test`,
          passwordHash: 'x',
          firstName: 'Lx',
          lastName: 'Owner',
          role: 'store_admin',
        },
      });
      ownerId = owner.id;
      storeId = (await prisma.store.create({ data: { name: tag, slug: tag, ownerId } })).id;
      // ~330-char descriptions (the same fill as the planner test in search-normalize-parity): the
      // per-row normalisation then costs enough that no plan is cheaper by luck.
      await prisma.$executeRaw`
      INSERT INTO public.products
        (id, store_id, name, name_ar, sku, description, slug, price, status, updated_at)
      SELECT ${tag} || '-' || g, ${storeId}, md5('n' || g), md5('a' || g), md5('s' || g),
             repeat(md5('d' || g) || ' ', 10), ${tag} || '-' || g, 1000, 'active', now()
      FROM generate_series(1, ${ROWS}::int) g`;
      await prisma.$executeRaw`ANALYZE public.products`;
    }, 120_000);

    afterAll(async () => {
      if (storeId) await prisma.store.delete({ where: { id: storeId } }).catch(() => undefined);
      if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => undefined);
      await app?.$disconnect();
    }, 120_000);

    const run = (term: string, opts: Parameters<typeof searchProductIds>[2]) =>
      asApp(() => runInTenantContext(storeId, () => searchProductIds(storeId, term, opts)));

    it('storefront search finds the product through products_search_doc_trgm_idx', async () => {
      const before = await idxScans('products_search_doc_trgm_idx');
      const ids = await run(md5('n7').slice(0, 10), { scope: 'storefront' });
      await flushAppStats();
      expect(ids).toEqual([`${tag}-7`]);
      expect(await idxScans('products_search_doc_trgm_idx')).toBeGreaterThan(before);
    }, 60_000);

    it('typeahead (field: name) uses products_name_doc_trgm_idx', async () => {
      const before = await idxScans('products_name_doc_trgm_idx');
      const ids = await run(md5('a9').slice(0, 10), { scope: 'storefront', field: 'name' });
      await flushAppStats();
      expect(ids).toEqual([`${tag}-9`]);
      expect(await idxScans('products_name_doc_trgm_idx')).toBeGreaterThan(before);
    }, 60_000);

    it('admin search (SKU arm) uses both the doc and the SKU index', async () => {
      const doc = await idxScans('products_search_doc_trgm_idx');
      const sku = await idxScans('products_sku_norm_trgm_idx');
      const ids = await run(md5('s11').slice(0, 10), { scope: 'admin' });
      await flushAppStats();
      expect(ids).toEqual([`${tag}-11`]);
      expect(await idxScans('products_search_doc_trgm_idx')).toBeGreaterThan(doc);
      expect(await idxScans('products_sku_norm_trgm_idx')).toBeGreaterThan(sku);
    }, 60_000);

    it('a multi-word query still ANDs every word, and a miss is empty', async () => {
      const both = await run(`${md5('n3').slice(0, 8)} ${md5('a3').slice(0, 8)}`, {
        scope: 'storefront',
      });
      expect(both).toEqual([`${tag}-3`]);
      const mixed = await run(`${md5('n3').slice(0, 8)} ${md5('a4').slice(0, 8)}`, {
        scope: 'storefront',
      });
      expect(mixed).toEqual([]);
    }, 60_000);

    // The definer runs as the owner, so it must itself refuse what RLS would: another store's id,
    // and any call outside a store scope.
    const callDefiner = (scopeStore: string | null, askStore: string) => {
      const call = () =>
        prisma.$queryRaw<Array<{ id: string }>>`
        SELECT public.ebda_product_search_ids(${askStore}, 'all', false, false, true, ARRAY['%a%']::text[]) AS id`;
      return asApp(() => (scopeStore ? runInTenantContext(scopeStore, call) : call()));
    };

    it('ebda_product_search_ids returns nothing for another store or outside a store scope', async () => {
      const other = (
        await prisma.store.create({ data: { name: `${tag}b`, slug: `${tag}b`, ownerId } })
      ).id;
      try {
        expect((await callDefiner(storeId, storeId)).length).toBeGreaterThan(0); // positive control
        expect(await callDefiner(other, storeId)).toEqual([]); // scoped to B, asking for A
        expect(await callDefiner(storeId, other)).toEqual([]); // scoped to A, asking for B
        expect(await callDefiner(null, storeId)).toEqual([]); // no scope at all
      } finally {
        await prisma.store.delete({ where: { id: other } }).catch(() => undefined);
      }
    }, 60_000);
  }
);
