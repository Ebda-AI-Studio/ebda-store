/**
 * Search program Task 12 (review I3): the must-hold "SEARCH_SEMANTIC_ENABLED off → the storefront
 * list is byte-identical to before Task 12", pinned. 22 request shapes (search, merchant category
 * order, price, featured, page, cursor, ids, option facets, every sort, the 10 000-skip cap, and
 * `sort=relevance`, which before Task 12 was dropped by the route and so ran as no sort) are run
 * through `ProductService.listPublic` with the flag UNSET and `false`; both must serialise to the
 * committed golden file, and no embedding call may happen.
 *
 * The golden was produced by this branch and checked equal to main's (03f7421c2)
 * `product.service.ts` run on the same fixture (Ruling SEARCH-T12-2). It goes red if the flag gate
 * is removed (search requests become relevance-ranked with `meta.ranked`), if the shared listing
 * select changes, or if any listing path changes its order or meta. If a change to the listing is
 * INTENDED, regenerate with `vitest -u` and say why in the PR.
 *
 * Stable output: fixture ids and slugs are random per run (retry-safe), so every UUID is replaced
 * by a label (fixture products by name, others by first appearance), the per-run tag by `<run>`,
 * and timestamps the fixture does not set by `<ts>`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import { prisma, runInTenantContext } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';
import { fakeProvider } from '../helpers/fake-embeddings';

vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })), createFunction: vi.fn(() => ({})) },
}));
const { ProductService } = await import('../../apps/api/src/services/product.service');
const { setEmbeddingProviderForTests } =
  await import('../../apps/api/src/lib/search/embedding-provider');

const RUN = crypto.randomBytes(4).toString('hex');
let S: string;
let ownerId: string;
const catSlug = `golden-cat-${RUN}`;
const products: Array<{ id: string; name: string }> = [];

/** The options each shape passes, as the route would after parsing. */
type Opts = Parameters<typeof ProductService.listPublic>[1];
const matrix = (pid: string[]): Array<{ name: string; opts: Opts }> => [
  { name: 'no search', opts: {} },
  { name: 'search shoes', opts: { search: 'shoes' } },
  { name: 'search arabic', opts: { search: 'احذيه' } },
  { name: 'search no keyword match', opts: { search: 'كوتشي' } },
  { name: 'search + category (merchant order)', opts: { search: 'shoes', category: catSlug } },
  { name: 'category (merchant order)', opts: { category: catSlug } },
  { name: 'search + price', opts: { search: 'shoes', minPrice: 1000, maxPrice: 2500 } },
  { name: 'search + featured', opts: { search: 'shoes', featured: true } },
  { name: 'search + not featured', opts: { search: 'shoes', featured: false } },
  { name: 'search page 2 of 1', opts: { search: 'shoes', page: 2, limit: 1 } },
  { name: 'search cursor', opts: { search: 'shoes', limit: 2, cursor: pid[1] } },
  { name: 'search + ids', opts: { search: 'shoes', ids: [pid[0], pid[2], pid[5]] } },
  { name: 'search + option facet', opts: { search: 'shoes', optionFilters: { Size: ['S'] } } },
  { name: 'search price_asc', opts: { search: 'shoes', sort: 'price_asc' } },
  { name: 'search price_desc', opts: { search: 'shoes', sort: 'price_desc' } },
  { name: 'search newest', opts: { search: 'shoes', sort: 'newest' } },
  { name: 'search best_seller', opts: { search: 'shoes', sort: 'best_seller' } },
  { name: 'price_asc page 2', opts: { sort: 'price_asc', limit: 3, page: 2 } },
  { name: 'skip cap', opts: { search: 'shoes', page: 20000, limit: 1 } },
  { name: 'search relevance', opts: { search: 'shoes', sort: 'relevance' } },
  {
    name: 'search + category relevance',
    opts: { search: 'shoes', category: catSlug, sort: 'relevance' },
  },
  { name: 'category relevance', opts: { sort: 'relevance', category: catSlug } },
];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
/** Fixture dates (createdAt) carry meaning (they order the lists); every other timestamp is noise. */
const FIXTURE_DATES = new Set(
  [...Array(6).keys()].map(i => new Date(Date.UTC(2026, 0, 1 + i)).toISOString())
);
function stable(doc: string): string {
  const labels = new Map<string, string>();
  for (const p of products) labels.set(p.id, `<product ${p.name}>`);
  labels.set(S, '<store>');
  let n = 0;
  return doc
    .replace(UUID, id => {
      if (!labels.has(id)) labels.set(id, `<id ${++n}>`);
      return labels.get(id)!;
    })
    .replaceAll(RUN, '<run>')
    .replace(ISO, ts => (FIXTURE_DATES.has(ts) ? ts : '<ts>'));
}

describe.skipIf(!hasDb)(
  'listing with semantic search off is unchanged (golden, Ruling SEARCH-T12-2)',
  () => {
    beforeAll(async () => {
      ownerId = (
        await prisma.user.create({
          data: {
            email: `golden-${RUN}@t.local`,
            passwordHash: 'x',
            firstName: 'G',
            lastName: 'L',
            role: 'store_admin',
          },
        })
      ).id;
      S = (await prisma.store.create({ data: { name: 'golden', slug: `golden-${RUN}`, ownerId } }))
        .id;
      const cat = await prisma.category.create({
        data: { storeId: S, name: 'Cat', slug: catSlug },
      });
      const tie = new Date(Date.UTC(2026, 0, 2));
      const rows = [
        { name: 'Leather shoes', nameAr: 'احذية جلد', price: 3000, featured: true, isNew: true },
        { name: 'Canvas shoes', price: 2000, isBestSeller: true, createdAt: tie },
        { name: 'Kids shoes', price: 1500, createdAt: tie },
        { name: 'Sport trainer', nameAr: 'حذاء رياضي', price: 5000 },
        { name: 'Shoes bag', price: 700, featured: true, createdAt: tie },
        { name: 'Hat', price: 100 },
      ];
      for (const [i, r] of rows.entries()) {
        const p = await prisma.product.create({
          data: {
            storeId: S,
            // Ordered ids (still unique per run): ties on createdAt break by id, so random ids would
            // make the golden flaky. The fixture keeps its two real ties on purpose.
            id: `0000000${i}-0000-4000-8000-${RUN}0000`,
            slug: `golden-${i}-${RUN}`,
            status: 'active',
            inventory: 5,
            createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
            ...r,
            images:
              i === 0
                ? { create: [{ url: 'https://example.test/a.png', position: 0 }] }
                : undefined,
            categories:
              i % 2 === 0 ? { create: { categoryId: cat.id, position: 10 - i } } : undefined,
          } as never,
        });
        products.push({ id: p.id, name: r.name });
      }
      const opt = await prisma.productOption.create({
        data: {
          productId: products[1].id,
          name: 'Size',
          values: { create: [{ value: 'S' }, { value: 'M' }] },
        },
        include: { values: true },
      });
      await prisma.productVariant.create({
        data: {
          productId: products[1].id,
          title: 'S',
          inventory: 3,
          price: 2100,
          options: { create: { valueId: opt.values[0].id } },
        } as never,
      });
    });

    afterAll(async () => {
      setEmbeddingProviderForTests(undefined);
      delete process.env.SEARCH_SEMANTIC_ENABLED;
      await prisma.product.deleteMany({ where: { storeId: S } });
      await prisma.category.deleteMany({ where: { storeId: S } });
      await prisma.store.deleteMany({ where: { id: S } });
      await prisma.user.deleteMany({ where: { id: ownerId } });
    });

    async function runMatrix(): Promise<string> {
      const parts: string[] = [];
      for (const { name, opts } of matrix(products.map(p => p.id))) {
        const out = await runInTenantContext(S, () => ProductService.listPublic(S, opts));
        parts.push(`## ${name}\n${JSON.stringify(out, null, 1)}`);
      }
      return stable(parts.join('\n\n')) + '\n';
    }

    it('flag unset and flag "false" both match the golden, with no embedding call', async () => {
      const f = fakeProvider();
      setEmbeddingProviderForTests(f.provider);
      delete process.env.SEARCH_SEMANTIC_ENABLED;
      const unset = await runMatrix();
      process.env.SEARCH_SEMANTIC_ENABLED = 'false';
      const off = await runMatrix();
      expect(matrix([]).length).toBe(22);
      expect(off).toBe(unset);
      expect(unset).not.toContain('"ranked"');
      expect(f.calls).toHaveLength(0);
      await expect(unset).toMatchFileSnapshot('./__snapshots__/listing-flag-off-golden.txt');
    });
  }
);
