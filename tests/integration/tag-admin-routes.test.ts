/**
 * Phase B3 fix wave 1 (Ruling B3-13): the admin tag routes. A tag has `name` (canonical, the
 * filter key) and `nameAr`; list and update are store-scoped and a rename cannot collide.
 * Real Postgres, the real router under tenantContext, a store_admin token.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { withRlsBypass } from '@ebda/database';
import {
  hasDb,
  seedBundleStore,
  storeAdminAccessTokenFor,
  type FixtureStore,
} from '../helpers/bundle-fixtures';

const { default: tagRoutes } = await import('../../apps/api/src/routes/tag.routes');
const { tenantContext } = await import('../../apps/api/src/middleware/tenant-context');
const { ProductService } = await import('../../apps/api/src/services/product.service');

const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!hasDb)('admin tag routes', () => {
  let app: Express;
  let a: FixtureStore;
  let b: FixtureStore;
  let tagA1: string;
  let tagA2: string;
  let tagB1: string;
  const auth = (s: FixtureStore) => ({
    Authorization: `Bearer ${storeAdminAccessTokenFor(s.ownerId)}`,
  });
  const url = (s: FixtureStore, p = '') => `/api/v1/stores/${s.storeId}/tags${p}`;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/stores/:storeId/tags', tenantContext, tagRoutes);
    a = await seedBundleStore(`${suffix}-a`);
    b = await seedBundleStore(`${suffix}-b`);
    await withRlsBypass(async tx => {
      tagA1 = (await tx.tag.create({ data: { storeId: a.storeId, name: 'Oily skin' } })).id;
      tagA2 = (await tx.tag.create({ data: { storeId: a.storeId, name: 'Acne' } })).id;
      tagB1 = (await tx.tag.create({ data: { storeId: b.storeId, name: 'Acne' } })).id;
    });
  });

  it('lists only this store tags with their label pair and product count', async () => {
    const res = await request(app).get(url(a)).set(auth(a)).expect(200);
    const names = res.body.data.tags.map((t: { name: string }) => t.name);
    expect(names).toEqual(['Acne', 'Oily skin']);
    expect(res.body.data.tags[0]).toMatchObject({ nameAr: null, productCount: 0 });
  });

  it('sets the Arabic label, which the public tag list then carries', async () => {
    await request(app)
      .put(url(a, `/${tagA1}`))
      .set(auth(a))
      .send({ nameAr: ' بشرة دهنية ' })
      .expect(200);
    const row = await withRlsBypass(tx => tx.tag.findUniqueOrThrow({ where: { id: tagA1 } }));
    expect(row.nameAr).toBe('بشرة دهنية'); // trimmed
    // a tag with a published product shows both labels on the storefront
    const pid = await withRlsBypass(
      async tx =>
        (
          await tx.product.create({
            data: {
              storeId: a.storeId,
              name: 'P',
              slug: `p-${suffix}`,
              price: 100,
              inventory: 5,
              status: 'active',
            },
          })
        ).id
    );
    await withRlsBypass(tx => tx.productTag.create({ data: { productId: pid, tagId: tagA1 } }));
    const pub = await ProductService.getPublicTags(a.storeId);
    expect(pub).toEqual([expect.objectContaining({ name: 'Oily skin', nameAr: 'بشرة دهنية' })]);
  });

  it('an empty Arabic label clears it (the storefront falls back to name)', async () => {
    await request(app)
      .put(url(a, `/${tagA1}`))
      .set(auth(a))
      .send({ nameAr: '' })
      .expect(200);
    expect(
      (await withRlsBypass(tx => tx.tag.findUniqueOrThrow({ where: { id: tagA1 } }))).nameAr
    ).toBeNull();
  });

  it('negative controls: another store tag id is a 404, a duplicate name is a 409, unknown keys are refused', async () => {
    await request(app)
      .put(url(a, `/${tagB1}`))
      .set(auth(a))
      .send({ nameAr: 'x' })
      .expect(404);
    expect(
      (await withRlsBypass(tx => tx.tag.findUniqueOrThrow({ where: { id: tagB1 } }))).nameAr
    ).toBeNull();
    const dup = await request(app)
      .put(url(a, `/${tagA2}`))
      .set(auth(a))
      .send({ name: 'Oily skin' });
    expect(dup.status).toBe(409);
    expect(
      (
        await request(app)
          .put(url(a, `/${tagA2}`))
          .set(auth(a))
          .send({ storeId: b.storeId })
      ).status
    ).toBeGreaterThanOrEqual(400);
    // the same NAME in the other store is fine (the key is per store)
    await request(app)
      .put(url(b, `/${tagB1}`))
      .set(auth(b))
      .send({ name: 'Acne', nameAr: 'حب' })
      .expect(200);
  });

  it('requires an authenticated store admin of that store', async () => {
    expect((await request(app).get(url(a))).status).toBe(401);
    expect((await request(app).get(url(a)).set(auth(b))).status).toBeGreaterThanOrEqual(403);
  });
});
