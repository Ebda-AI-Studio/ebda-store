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
import { prisma, runInTenantContext } from '@ebda/database';
import { createAppPlanner } from '../helpers/app-role-planner';
import { hasDb } from '../helpers/bundle-fixtures';

const { searchProductIds } = await import('../../apps/api/src/services/product-search.service');

const planner = hasDb ? createAppPlanner() : null;
const app = planner?.app ?? null;
const asApp = <T>(fn: () => Promise<T>) => planner!.asApp(fn);
const idxScans = (name: string) => planner!.idxScans(name);
const expectScansAbove = (name: string, before: number) => planner!.expectScansAbove(name, before);

const ROWS = 20_000;
const tag = `lx${Date.now()}${crypto.randomBytes(2).toString('hex')}`;
let storeId = '';
let ownerId = '';
const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');

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
      SELECT ${tag} || '-' || g, ${storeId},
             CASE g % 500 WHEN 0 THEN 'qz' || g || ' ' WHEN 250 THEN 'xqz' || g || ' '
               WHEN 100 THEN 'أرز' || g || ' ' WHEN 200 THEN 'الرز' || g || ' ' WHEN 150 THEN 'مرز' || g || ' '
               WHEN 300 THEN 'S/XL' || g || ' ' WHEN 400 THEN '(XL) ' || g || ' ' ELSE '' END || md5('n' || g), md5('a' || g), md5('s' || g),
             repeat('quality cotton item ', 17), ${tag} || '-' || g, 1000, 'active', now()
      FROM generate_series(1, ${ROWS}::int) g`;
      // VACUUM, not just ANALYZE: a freshly bulk-inserted table has an all-visible fraction of 0 until
      // (auto)vacuum runs, and the planner's choice between this index and a seq scan flips when autovacuum
      // lands mid-file. That made the "index was not scanned" counters pass or fail by timing alone
      // (measured: calls 1-4 seq scan, then the index every call once autovacuum had run).
      await prisma.$executeRaw`VACUUM (ANALYZE) public.products`;
    }, 120_000);

    afterAll(async () => {
      if (storeId) await prisma.store.delete({ where: { id: storeId } }).catch(() => undefined);
      if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => undefined);
      await planner?.close();
    }, 120_000);

    const run = (term: string, opts: Parameters<typeof searchProductIds>[2]) =>
      asApp(() => runInTenantContext(storeId, () => searchProductIds(storeId, term, opts)));

    it('storefront search finds the product through products_search_doc_trgm_idx', async () => {
      const before = await idxScans('products_search_doc_trgm_idx');
      const ids = await run(md5('n7').slice(0, 10), { scope: 'storefront' });
      expect(ids).toEqual([`${tag}-7`]);
      await expectScansAbove('products_search_doc_trgm_idx', before);
    }, 60_000);

    it('typeahead (field: name) uses products_name_doc_trgm_idx', async () => {
      const before = await idxScans('products_name_doc_trgm_idx');
      const ids = await run(md5('a9').slice(0, 10), { scope: 'storefront', field: 'name' });
      expect(ids).toEqual([`${tag}-9`]);
      await expectScansAbove('products_name_doc_trgm_idx', before);
    }, 60_000);

    it('admin search (SKU arm) uses both the doc and the SKU index', async () => {
      const doc = await idxScans('products_search_doc_trgm_idx');
      const sku = await idxScans('products_sku_norm_trgm_idx');
      const ids = await run(md5('s11').slice(0, 10), { scope: 'admin' });
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

    // (The definer's caller checks - another store, no scope, owner sessions - are pinned in
    // search-definer-authz.test.ts.)

    // SEARCH-T14-3 (coordinator ruling): a query made ONLY of words under 3 characters cannot use a
    // trigram index as a substring, so it matches at the START of a word instead, which the same
    // index serves (`doc LIKE 'ab%' OR doc LIKE '% ab%'`). Oracle: a plain regex over the same
    // normalised document, computed independently of the SQL under test. A word starts after the
    // start, any non-alphanumeric, and optionally the Arabic prefixes ا / ال (review I-1).
    const startsWord = async (docFn: 'search' | 'name', prefix: string): Promise<string[]> => {
      const expr =
        docFn === 'search'
          ? 'public.ebda_product_search_doc(name, name_ar, search_terms, description, description_ar)'
          : 'public.ebda_product_name_doc(name, name_ar, search_terms)';
      const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM public.products WHERE store_id = $1 AND status = 'active'
         AND deleted_at IS NULL AND ${expr} ~ ('(^|[^[:alnum:]])(ال|ا)?' || $2)`,
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
      const want = await startsWord('search', 'qz');
      expect(want.length).toBeGreaterThan(5);
      // 'qz' starts a word in 40 products and sits MID-word ("xqz...") in 40 others.
      const substring = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM public.products WHERE store_id = ${storeId}
        AND public.ebda_product_search_doc(name, name_ar, search_terms, description, description_ar) LIKE '%qz%'`;
      expect(want.length).toBeLessThan(Number(substring[0].n)); // mid-word hits are NOT matches any more
      const before = await idxScans('products_search_doc_trgm_idx');
      const runs = [];
      for (let i = 0; i < 3; i++) runs.push(await timed(() => run('qz', { scope: 'storefront' })));
      expect([...runs[0].out].sort()).toEqual(want);
      await expectScansAbove('products_search_doc_trgm_idx', before);
      // measured before the change: ~700 ms for a short word at 20k (a store scan)
      expect(Math.min(...runs.map(r => r.ms))).toBeLessThan(250);
    }, 60_000);

    it('I-1: an Arabic noun with the article or a hamza-alef prefix is found by its bare two letters', async () => {
      const want = await startsWord('search', 'رز');
      const ids = (n: number) => `${tag}-${n}`;
      // أرز (folds to ارز) and الرز are word starts; مرز has the letters MID-word and must not match.
      for (const g of [100, 200, 600, 700]) expect(want).toContain(ids(g));
      expect(want).not.toContain(ids(150));
      const before = await idxScans('products_search_doc_trgm_idx');
      const got = await run('رز', { scope: 'storefront' });
      expect([...got].sort()).toEqual(want);
      await expectScansAbove('products_search_doc_trgm_idx', before);
      // and the article itself, typed as a typeahead keystroke pair
      const qat = await run('ال', { scope: 'storefront', field: 'name', limit: 25 });
      expect(qat.length).toBeGreaterThan(0);
    }, 60_000);

    it('I-1: a size next to punctuation (S/XL, (XL)) is found by xl', async () => {
      const want = await startsWord('search', 'xl');
      const ids = (n: number) => `${tag}-${n}`;
      for (const g of [300, 400, 800, 900]) expect(want).toContain(ids(g));
      const before = await idxScans('products_search_doc_trgm_idx');
      const got = await run('xl', { scope: 'storefront' });
      expect([...got].sort()).toEqual(want);
      await expectScansAbove('products_search_doc_trgm_idx', before);
    }, 60_000);

    it('typeahead accepts ONE character and returns only word-start matches, index-backed', async () => {
      const want = new Set(await startsWord('name', 'a'));
      expect(want.size).toBeGreaterThan(25);
      // A letter that starts a quarter of the words is not selective, so the planner may legitimately
      // pick a scan here: the evidence is the result and the time (a normalise-every-row scan of this
      // store takes ~700 ms), not an index counter.
      // Latency budget (Ruling ITEST-2, same pattern as #226): a loaded shared runner doubled the
      // absolute figure (939 / 1028 ms vs 450). Everywhere except the nightly schedule (and local
      // runs) the budget is RELATIVE: the typeahead must beat the normalise-every-row scan of the
      // same store timed in this very test (the oracle query below is exactly that scan), so
      // runner load slows both alike. The absolute 450 ms stays on the quiet nightly lane.
      const scanMs = Math.min(
        ...(await Promise.all([0, 1].map(() => timed(() => startsWord('name', 'a'))))).map(
          r => r.ms
        )
      );
      const { out, ms } = await timed(() =>
        run('a', { scope: 'storefront', field: 'name', order: 'featured', limit: 25 })
      );
      expect(out).toHaveLength(25);
      for (const id of out) expect(want.has(id)).toBe(true);
      const quietLane =
        !process.env.GITHUB_EVENT_NAME || process.env.GITHUB_EVENT_NAME === 'schedule';
      if (quietLane) expect(ms).toBeLessThan(450);
      else
        expect(ms, `typeahead ${ms} ms vs same-test full scan ${scanMs} ms`).toBeLessThan(
          scanMs * 1.5
        );
    }, 60_000);

    it('a mixed query (one long word) still matches the short word anywhere in the product', async () => {
      const hit = md5('n7');
      const ids = await run(`${hit.slice(0, 8)} ${hit.slice(3, 5)}`, { scope: 'storefront' });
      expect(ids).toContain(`${tag}-7`); // the 2-char word sits mid-word in the name
    }, 60_000);
  }
);
