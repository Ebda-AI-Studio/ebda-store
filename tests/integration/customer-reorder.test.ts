/**
 * Phase B4 Task 4, Ruling B4-8: `GET /public/customers/me/reorder` against real Postgres, through
 * the real public router on the strict `ebda_app` role. The id list is per customer: distinct
 * products from the last three PAID or DELIVERED orders, newest first, at most 12, still on sale.
 * Negative controls: another customer's orders, another store's orders, cancelled and unpaid
 * orders, archived and deleted products, a fourth-oldest order. Always `private, no-store`;
 * anonymous is 401; an admin token is 403.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createPrismaClient, runWithRequestDb, withRlsBypass } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';

vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })), createFunction: vi.fn(() => ({})) },
}));
const { awaitDeferredWork } = await import('../../apps/api/src/lib/after-tenant-commit');
const { default: publicRoutes } = await import('../../apps/api/src/routes/public.routes');
const { publicStoreContext } = await import('../../apps/api/src/middleware/tenant-context');
const { errorHandler } = await import('../../apps/api/src/middleware/error-handler');
const { config } = await import('../../apps/api/src/config');
const { CustomerReorderService } =
  await import('../../apps/api/src/services/customer-reorder.service');

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn, {
    beforeDisconnect: () => awaitDeferredWork(5000),
  });

function buildApp(): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use((_req: Request, res: Response, next: NextFunction) => {
    asApp(
      () =>
        new Promise<void>(resolve => {
          res.once('finish', resolve);
          res.once('close', resolve);
          next();
        })
    ).catch(next);
  });
  app.use('/api/v1/public', publicStoreContext);
  app.use('/api/v1/public', publicRoutes);
  app.use(errorHandler);
  return app;
}

const token = (userId: string, role: 'customer' | 'store_admin') =>
  jwt.sign({ userId, email: `${userId}@example.test`, role, tv: 0 }, config.jwtSecret, {
    expiresIn: '10m',
    issuer: 'ebda-api',
    audience: 'ebda-app',
  });

describe.skipIf(!hasDb)('customer reorder source (Ruling B4-8)', () => {
  const run = `${Date.now().toString(36)}-${process.pid}-${randomUUID().slice(0, 6)}`;
  let app: Express;
  let storeId: string;
  let otherStoreId: string;
  let ownerId: string;
  let customerId: string;
  let otherCustomerId: string;
  let newCustomerId: string;
  const p: Record<string, string> = {};
  let seq = 0;

  async function mkUser(label: string, role: 'customer' | 'store_admin' = 'customer') {
    return withRlsBypass(
      async tx =>
        (
          await tx.user.create({
            data: {
              email: `reorder-${label}-${run}@example.test`,
              passwordHash: 'x',
              role,
              firstName: 'Re',
              lastName: label,
            },
          })
        ).id
    );
  }
  async function mkProduct(
    sid: string,
    key: string,
    extra: { status?: 'active' | 'archived' | 'draft'; deletedAt?: Date } = {}
  ) {
    p[key] = await withRlsBypass(
      async tx =>
        (
          await tx.product.create({
            data: {
              storeId: sid,
              name: `Reorder ${key}`,
              slug: `ro-${key}-${run}`,
              price: 5000,
              inventory: 10,
              status: 'active',
              ...extra,
            },
          })
        ).id
    );
  }
  async function mkOrder(opts: {
    sid: string;
    cid: string;
    keys: string[];
    at: Date;
    status?: 'pending' | 'confirmed' | 'delivered' | 'cancelled' | 'refunded';
    paymentStatus?: 'unpaid' | 'paid';
  }) {
    seq += 1;
    await withRlsBypass(async tx => {
      await tx.order.create({
        data: {
          storeId: opts.sid,
          customerId: opts.cid,
          orderNumber: `RO-${run}-${seq}`,
          status: opts.status ?? 'confirmed',
          paymentStatus: opts.paymentStatus ?? 'paid',
          subtotal: 5000,
          total: 5000,
          shippingAddress: {},
          createdAt: opts.at,
          items: {
            create: opts.keys.map(k => ({
              productId: p[k],
              productName: `Reorder ${k}`,
              quantity: 1,
              price: 5000,
              total: 5000,
            })),
          },
        },
      });
    });
  }

  beforeAll(async () => {
    app = buildApp();
    ownerId = await mkUser('owner', 'store_admin');
    customerId = await mkUser('c1');
    otherCustomerId = await mkUser('c2');
    newCustomerId = await mkUser('c3');
    const mkStore = (label: string) =>
      withRlsBypass(
        async tx =>
          (
            await tx.store.create({
              data: {
                name: `ro-${label}-${run}`,
                slug: `ro-${label}-${run}`,
                ownerId,
                status: 'active',
              },
            })
          ).id
      );
    storeId = await mkStore('a');
    otherStoreId = await mkStore('b');
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n'])
      await mkProduct(storeId, k);
    await mkProduct(storeId, 'archived', { status: 'archived' });
    await mkProduct(storeId, 'deleted', { deletedAt: new Date() });
    await mkProduct(storeId, 'cancelled-only');
    await mkProduct(storeId, 'unpaid-only');
    await mkProduct(storeId, 'old');
    await mkProduct(otherStoreId, 'foreign');
    const day = (n: number) => new Date(Date.now() - n * 86_400_000);
    // the customer's qualifying orders: newest first -> order3, order2, order1
    await mkOrder({ sid: storeId, cid: customerId, keys: ['a', 'b'], at: day(9) }); // order1
    await mkOrder({
      sid: storeId,
      cid: customerId,
      keys: ['c', 'a', 'archived', 'deleted'],
      at: day(5),
    }); // order2
    await mkOrder({
      sid: storeId,
      cid: customerId,
      keys: ['d', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n'],
      at: day(1),
      status: 'delivered',
      paymentStatus: 'unpaid', // cash on delivery, delivered
    }); // order3
    // do NOT count
    await mkOrder({
      sid: storeId,
      cid: customerId,
      keys: ['cancelled-only'],
      at: day(0.5),
      status: 'cancelled',
    });
    await mkOrder({
      sid: storeId,
      cid: customerId,
      keys: ['unpaid-only'],
      at: day(0.4),
      status: 'pending',
      paymentStatus: 'unpaid',
    });
    await mkOrder({ sid: storeId, cid: customerId, keys: ['old'], at: day(30) }); // the fourth qualifying order
    await mkOrder({ sid: storeId, cid: otherCustomerId, keys: ['b'], at: day(2) });
  });

  it('is the distinct products of the last three paid or delivered orders, newest order first, at most 12, on sale only', async () => {
    const ids = await CustomerReorderService.productIds(storeId, customerId);
    // order3 has 11 products (d..n), then order2 adds c (a is next), then order1 adds b: capped at 12
    expect(ids).toEqual([...'defghijklmn', 'c'].map(k => p[k]));
    expect(ids).toHaveLength(12);
    const all = await CustomerReorderService.productIds(storeId, customerId, 12);
    expect(all.every(id => id !== p.archived && id !== p.deleted)).toBe(true);
  });

  it('negative controls: cancelled, unpaid, the fourth-oldest order, archived and deleted never appear', async () => {
    const ids = new Set(await CustomerReorderService.productIds(storeId, customerId));
    for (const k of ['cancelled-only', 'unpaid-only', 'old', 'archived', 'deleted', 'foreign'])
      expect(ids.has(p[k]), k).toBe(false);
  });

  it('is scoped to the customer and the store', async () => {
    expect(await CustomerReorderService.productIds(storeId, otherCustomerId)).toEqual([p.b]);
    expect(await CustomerReorderService.productIds(storeId, newCustomerId)).toEqual([]);
    expect(await CustomerReorderService.productIds(otherStoreId, customerId)).toEqual([]);
  });

  it('a smaller limit keeps the newest', async () => {
    const ids = await CustomerReorderService.productIds(storeId, customerId, 3);
    expect(ids).toEqual(['d', 'e', 'f'].map(k => p[k]));
  });

  it('HTTP: a signed-in customer gets the ids, private and uncacheable', async () => {
    const res = await request(app)
      .get('/api/v1/public/customers/me/reorder')
      .set('x-store-id', storeId)
      .set('Authorization', `Bearer ${token(customerId, 'customer')}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.productIds).toHaveLength(12);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(String(res.headers.vary)).toMatch(/Authorization/i);
  });

  it('HTTP: another customer sees only their own; the same token on another store sees nothing', async () => {
    const mine = await request(app)
      .get('/api/v1/public/customers/me/reorder')
      .set('x-store-id', storeId)
      .set('Authorization', `Bearer ${token(otherCustomerId, 'customer')}`);
    expect(mine.body.data.productIds).toEqual([p.b]);
    const elsewhere = await request(app)
      .get('/api/v1/public/customers/me/reorder')
      .set('x-store-id', otherStoreId)
      .set('Authorization', `Bearer ${token(customerId, 'customer')}`);
    expect(elsewhere.status).toBe(200);
    expect(elsewhere.body.data.productIds).toEqual([]);
  });

  it('HTTP: anonymous is 401 and an admin token is 403', async () => {
    const anon = await request(app)
      .get('/api/v1/public/customers/me/reorder')
      .set('x-store-id', storeId);
    expect(anon.status).toBe(401);
    const admin = await request(app)
      .get('/api/v1/public/customers/me/reorder')
      .set('x-store-id', storeId)
      .set('Authorization', `Bearer ${token(ownerId, 'store_admin')}`);
    expect(admin.status).toBe(403);
  });
});
