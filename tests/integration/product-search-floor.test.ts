/**
 * Public product search floor + trigram index (adversarial audit P1-3).
 *
 * GET /public/products passed `search` straight through to an unbounded
 * leading-wildcard ILIKE over 4 TEXT columns with no minimum length, no
 * token cap, and no trigram index — and the cache key embeds the search
 * term, so unique-term traffic bypassed Redis, the in-memory map AND the
 * single-flight registry and ran a full seq scan per request (a 30-byte GET
 * amplified into a table scan, billed on Neon compute).
 *
 * Fix under test:
 *   - a search shorter than 2 chars short-circuits to an empty result with
 *     no DB or cache touch (mirrors /search/suggest's >= 2 floor);
 *   - the term is length-capped and `searchTokens` (@ebda/shared) caps the
 *     token count so a crafted query cannot expand into hundreds of LIKE clauses;
 *   - pg_trgm GIN indexes exist on products.name/name_ar/description/
 *     description_ar so the ILIKE is index-backed (all four OR arms must be
 *     indexable or the planner still seq-scans).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { prisma, withRlsBypass } from '@ebda/database';
import publicRoutes from '@api/routes/public.routes';
import { publicStoreContext } from '@api/middleware/tenant-context';
import { searchTokens } from '@ebda/shared';

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

const app = express();
app.use(express.json());
// As in app.ts: the public router runs under the store's tenant context (the search lookups are
// SECURITY DEFINER and take the store from the scoped session; Task 14 security review).
app.use('/api/v1/public', publicStoreContext, publicRoutes);

describe.skipIf(!hasDb)('public product search floor', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).substring(7)}`;
  let storeId: string;

  beforeAll(async () => {
    await withRlsBypass(async tx => {
      const owner = await tx.user.create({
        data: {
          email: `psf-owner-${suffix}@example.com`,
          passwordHash: 'not-a-real-hash',
          role: 'store_admin',
          firstName: 'PSF',
          lastName: 'Owner',
        },
      });
      const store = await tx.store.create({
        data: {
          name: 'psf-test-store',
          slug: `psf-test-${suffix}`,
          template: 'qamar',
          currency: 'EGP',
          ownerId: owner.id,
          status: 'active',
        },
      });
      storeId = store.id;

      await tx.product.createMany({
        data: [
          {
            storeId,
            name: `denim jacket ${suffix}`,
            slug: `psf-denim-${suffix}`,
            price: 1000,
            inventory: 5,
            status: 'active',
          },
          {
            storeId,
            name: `cotton shirt ${suffix}`,
            slug: `psf-cotton-${suffix}`,
            price: 2000,
            inventory: 5,
            status: 'active',
          },
        ],
      });
    });
  });

  afterAll(async () => {
    await withRlsBypass(async tx => {
      await tx.product.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.store.deleteMany({ where: { id: storeId } }).catch(() => {});
      await tx.user.deleteMany({ where: { email: { contains: suffix } } }).catch(() => {});
    });
  });

  it('a sub-floor (1-char) search returns an empty result instead of an unbounded ILIKE scan', async () => {
    const res = await request(app)
      .get('/api/v1/public/products?search=a')
      .set('x-store-id', storeId);
    expect(res.status).toBe(200);
    // Both seeded names contain "a" — an empty result proves the floor
    // short-circuited rather than running the scan.
    expect(res.body.data.products).toEqual([]);
    expect(res.body.data.meta.total).toBe(0);
  });

  it('a >= 2 char search still filters normally', async () => {
    const res = await request(app)
      .get(`/api/v1/public/products?search=denim`)
      .set('x-store-id', storeId);
    expect(res.status).toBe(200);
    const names = res.body.data.products.map((p: { name: string }) => p.name);
    expect(names).toContain(`denim jacket ${suffix}`);
    expect(names).not.toContain(`cotton shirt ${suffix}`);
  });

  it('a crafted many-token search is capped, not expanded into hundreds of ILIKE clauses', () => {
    const crafted = Array.from({ length: 50 }, (_, i) => `tok${i}`).join(' ');
    expect(searchTokens(crafted)).toHaveLength(8);
    expect(searchTokens('a b c d e f g h i j')).toHaveLength(8);
  });

  it('pg_trgm GIN indexes exist on all four searched columns, the two normalised docs (fold B and hamza fold A) and the SKU', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'products' AND indexdef ILIKE '%gin_trgm_ops%'
    `;
    const names = rows.map(r => r.indexname).sort();
    expect(names).toEqual([
      'products_description_ar_trgm_idx',
      'products_description_trgm_idx',
      'products_name_ar_trgm_idx',
      'products_name_doc_h_trgm_idx', // fold A (hamza), migration 20261123200000_search_fold_hamza
      'products_name_doc_trgm_idx',
      'products_name_trgm_idx',
      'products_search_doc_h_trgm_idx', // fold A (hamza), migration 20261123200000_search_fold_hamza
      'products_search_doc_trgm_idx',
      'products_sku_norm_trgm_idx',
    ]);
  });
});
