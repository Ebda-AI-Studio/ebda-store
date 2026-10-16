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
/** The counter is flushed asynchronously (and later under load): poll up to 5 s instead of one sleep. */
async function expectScansAbove(name: string, before: number) {
  let now = before;
  for (let i = 0; i < 50 && now <= before; i++) {
    await flushAppStats();
    now = await idxScans(name);
    if (now <= before) await new Promise(r => setTimeout(r, 100));
  }
  expect(now).toBeGreaterThan(before);
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
             repeat('quality cotton item ', 17), ${tag} || '-' || g, 1000, 'active', now()
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
      await expectScansAbove('products_search_doc_trgm_idx', before);
    }, 60_000);

    it('typeahead (field: name) uses products_name_doc_trgm_idx', async () => {
      const before = await idxScans('products_name_doc_trgm_idx');
      const ids = await run(md5('a9').slice(0, 10), { scope: 'storefront', field: 'name' });
      await flushAppStats();
      expect(ids).toEqual([`${tag}-9`]);
      await expectScansAbove('products_name_doc_trgm_idx', before);
    }, 60_000);

    it('admin search (SKU arm) uses both the doc and the SKU index', async () => {
      const doc = await idxScans('products_search_doc_trgm_idx');
      const sku = await idxScans('products_sku_norm_trgm_idx');
      const ids = await run(md5('s11').slice(0, 10), { scope: 'admin' });
      await flushAppStats();
      expect(ids).toEqual([`${tag}-11`]);
      await expectScansAbove('products_search_doc_trgm_idx', doc);
      await expectScansAbove('products_sku_norm_trgm_idx', sku);
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
        SELECT public.ebda_product_search_ids(${askStore}, 'all', false, false, true, false, ARRAY['%a%']::text[]) AS id`;
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

    // SEARCH-T14-3 (coordinator ruling): a query made ONLY of words under 3 characters cannot use a
    // trigram index as a substring, so it matches at the START of a word instead, which the same
    // index serves (`doc LIKE 'ab%' OR doc LIKE '% ab%'`). Oracle: a plain regex over the same
    // normalised document, computed independently of the SQL under test.
    const startsWord = async (docFn: 'search' | 'name', prefix: string): Promise<string[]> => {
      const expr =
        docFn === 'search'
          ? 'public.ebda_product_search_doc(name, name_ar, search_terms, description, description_ar)'
          : 'public.ebda_product_name_doc(name, name_ar, search_terms)';
      const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM public.products WHERE store_id = $1 AND status = 'active'
         AND deleted_at IS NULL AND ${expr} ~ ('(^| )' || $2)`,
        storeId,
        prefix
      );
      return rows.map(r => r.id).sort();
    };
    const timed = async <T>(fn: () => Promise<T>): Promise<{ out: T; ms: number }> => {
      const t0 = performance.now();
      const out = await fn();
      return { out, ms: performance.now() - t0 };
    };

    it('a 2-character query matches word starts, index-backed and fast at 20,000 products', async () => {
      const want = await startsWord('search', 'ab');
      expect(want.length).toBeGreaterThan(5);
      const substring = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM public.products WHERE store_id = ${storeId}
        AND public.ebda_product_search_doc(name, name_ar, search_terms, description, description_ar) LIKE '%ab%'`;
      expect(want.length).toBeLessThan(Number(substring[0].n)); // mid-word hits are NOT matches any more
      const before = await idxScans('products_search_doc_trgm_idx');
      const runs = [];
      for (let i = 0; i < 3; i++) runs.push(await timed(() => run('ab', { scope: 'storefront' })));
      expect([...runs[0].out].sort()).toEqual(want);
      await expectScansAbove('products_search_doc_trgm_idx', before);
      // measured before the change: ~700 ms for a short word at 20k (a store scan)
      expect(Math.min(...runs.map(r => r.ms))).toBeLessThan(250);
    }, 60_000);

    it('typeahead accepts ONE character and returns only word-start matches, index-backed', async () => {
      const want = new Set(await startsWord('name', 'a'));
      expect(want.size).toBeGreaterThan(25);
      // A letter that starts a quarter of the words is not selective, so the planner may legitimately
      // pick a scan here: the evidence is the result and the time (a normalise-every-row scan of this
      // store takes ~700 ms), not an index counter.
      const { out, ms } = await timed(() =>
        run('a', { scope: 'storefront', field: 'name', order: 'featured', limit: 25 })
      );
      expect(out).toHaveLength(25);
      for (const id of out) expect(want.has(id)).toBe(true);
      expect(ms).toBeLessThan(450);
    }, 60_000);

    it('a mixed query (one long word) still matches the short word anywhere in the product', async () => {
      const hit = md5('n7');
      const ids = await run(`${hit.slice(0, 8)} ${hit.slice(3, 5)}`, { scope: 'storefront' });
      expect(ids).toContain(`${tag}-7`); // the 2-char word sits mid-word in the name
    }, 60_000);
  }
);
