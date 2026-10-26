/**
 * GET /public/stores/:storeId/testimonials under strict RLS (R-EBDA-001).
 *
 * Found by the Dahab pilot (2026-10-07): the route read `reviews` (and the
 * customer's name from `users`) with no tenant context, so on the strict
 * `ebda_app` role it returned [] for every store and the homepage
 * testimonials section never rendered. The request here runs exactly like
 * production: an `ebda_app` login, no store header, the store only in the
 * path. Store B's review must never appear in store A's list.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createPrismaClient, runWithRequestDb, type AppPrismaClient } from '@ebda/database';
import publicStoreLayoutRoutes from '../../apps/api/src/routes/public-store-layout.routes';
import { setAppRoleLogin } from '../helpers/app-role-login';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const PREFIX = `tst-${crypto.randomUUID().slice(0, 8)}-`;

let owner: AppPrismaClient;
const ids = { storeA: '', storeB: '' };

function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return u.toString();
}

async function seedStoreWithReview(tag: string, firstName: string, rating: number) {
  const ownerUser = await owner.user.create({
    data: {
      email: `${PREFIX}${tag}-owner@test.com`,
      passwordHash: 'x',
      firstName: tag,
      lastName: 'O',
      role: 'store_admin' as never,
    },
  });
  const store = await owner.store.create({
    data: { slug: `${PREFIX}${tag}`, name: tag, ownerId: ownerUser.id },
  });
  const product = await owner.product.create({
    data: {
      storeId: store.id,
      name: `${tag}-p`,
      slug: `${PREFIX}${tag}-p`,
      price: 100,
      status: 'active' as never,
    },
  });
  const customer = await owner.user.create({
    data: {
      storeId: store.id,
      email: `${PREFIX}${tag}-c@test.com`,
      passwordHash: 'x',
      firstName,
      lastName: 'Hassan',
      role: 'customer' as never,
    },
  });
  const address = { firstName, lastName: 'Hassan', city: 'Cairo', country: 'EG', address1: 'x' };
  const order = await owner.order.create({
    data: {
      storeId: store.id,
      orderNumber: `${PREFIX}${tag}-1`,
      customerId: customer.id,
      subtotal: 100,
      total: 100,
      status: 'delivered' as never,
      shippingAddress: address,
      billingAddress: address,
    },
  });
  await owner.review.create({
    data: {
      storeId: store.id,
      productId: product.id,
      orderId: order.id,
      customerId: customer.id,
      rating,
      body: `${tag} review`,
      status: 'published',
      verifiedPurchase: true,
    },
  });
  return store.id;
}

beforeAll(async () => {
  owner = createPrismaClient({ connectionString: OWNER_URL, max: 3, role: 'owner' });
  await setAppRoleLogin(owner, APP_PASSWORD);
  ids.storeA = await seedStoreWithReview('a', 'Nour', 5);
  ids.storeB = await seedStoreWithReview('b', 'Mariam', 5);
});

afterAll(async () => {
  const inPrefix = `IN (SELECT id FROM public.stores WHERE slug LIKE '${PREFIX}%')`;
  for (const t of ['reviews', 'orders', 'products'])
    await owner.$executeRawUnsafe(`DELETE FROM public.${t} WHERE store_id ${inPrefix}`);
  await owner.$executeRawUnsafe(
    `DELETE FROM public.users WHERE email LIKE '${PREFIX}%' AND store_id IS NOT NULL`
  );
  await owner.$executeRawUnsafe(`DELETE FROM public.stores WHERE slug LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM public.users WHERE email LIKE '${PREFIX}%'`);
  await owner.$disconnect();
});

describe('public testimonials on the strict ebda_app role', () => {
  // Every request on its own ebda_app client, no tenant context (as in production).
  const app = express();
  app.use((req, res, next) => {
    runWithRequestDb(
      () => createPrismaClient({ connectionString: appUrl(), max: 1 }),
      () =>
        new Promise<void>(resolve => {
          res.on('finish', () => resolve());
          next();
        })
    ).catch(next);
  });
  app.use('/public', publicStoreLayoutRoutes);

  it("returns the store's published reviews with the customer's name", async () => {
    const res = await request(app).get(
      `/public/stores/${ids.storeA}/testimonials?minRating=4&verifiedOnly=true`
    );
    expect(res.status).toBe(200);
    expect(res.body.data.testimonials).toHaveLength(1);
    expect(res.body.data.testimonials[0]).toMatchObject({
      comment: 'a review',
      authorName: 'Nour H.',
    });
  });

  it("never returns another store's reviews", async () => {
    const res = await request(app).get(`/public/stores/${ids.storeB}/testimonials`);
    expect(res.body.data.testimonials.map((t: { comment: string }) => t.comment)).toEqual([
      'b review',
    ]);
  });
});
