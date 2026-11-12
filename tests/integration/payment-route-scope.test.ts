/**
 * GET /payments/status/:tx and GET /payments/order/:id under strict RLS,
 * with the code under test bound to a real `ebda_app` login. They used to read with no store
 * scope (an empty result, so a 404 for everyone). Now the store comes from the order / payment
 * through the definers and every read runs inside it:
 *   - the owner of the right store gets the payment,
 *   - the admin of ANOTHER store gets 404,
 *   - an unknown reference gets 404.
 *
 * Mutation proof: drop the `withStore(statusStoreId, ...)` around the status ownership read (or
 * the definer lookup) and the "right store" cases go red.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { createPrismaClient, runWithRequestDb, type AppPrismaClient } from '@ebda/database';
import { config } from '@api/config';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import paymentRoutes from '@api/routes/payment.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { PaymentService } from '@api/services/payment-providers/payment.factory';
import { redis } from '@api/services/redis.service';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const hasDb = !!OWNER_URL && !OWNER_URL.includes('localhost:5432/test_db');
const run = crypto.randomUUID().slice(0, 8);
const BYPASS = `prs-bypass-${run}`;
process.env.LOAD_TEST_BYPASS_TOKEN = BYPASS;

function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn, {
    beforeDisconnect: () => awaitDeferredWork(5000),
  });
const token = (userId: string, role: string) =>
  jwt.sign({ userId, email: `${userId}@example.test`, role, tv: 0 }, config.jwtSecret, {
    expiresIn: '30m',
    issuer: 'ebda-api',
    audience: 'ebda-app',
  });

describe.skipIf(!hasDb)('payment routes resolve their store under strict RLS', () => {
  let owner: AppPrismaClient;
  let app: Express;
  const storeIds: string[] = [];
  const userIds: string[] = [];

  async function mkStore(tag: string) {
    const admin = await owner.user.create({
      data: {
        email: `prs-${tag}-${run}@test.local`,
        passwordHash: 'x',
        firstName: 'P',
        lastName: tag,
        role: 'store_admin',
        emailVerified: true,
      },
    });
    userIds.push(admin.id);
    const store = await owner.store.create({
      data: {
        name: `prs-${tag}-${run}`,
        slug: `prs-${tag}-${run}`,
        ownerId: admin.id,
        status: 'active',
      },
    });
    storeIds.push(store.id);
    await owner.paymentConfig.create({
      data: { storeId: store.id, provider: 'cod', isEnabled: true, isDefault: true },
    });
    const order = await owner.order.create({
      data: {
        storeId: store.id,
        orderNumber: `PRS-${tag}-${run}`,
        status: 'confirmed',
        paymentStatus: 'paid',
        subtotal: 5000,
        total: 5000,
        shippingAddress: {},
        billingAddress: {},
      },
    });
    const tx = `prs-tx-${tag}-${run}`;
    await owner.payment.create({
      data: {
        orderId: order.id,
        provider: 'instapay',
        status: 'completed',
        amount: 5000,
        transactionId: tx,
      },
    });
    return { id: store.id, jwt: token(admin.id, 'store_admin'), orderId: order.id, tx };
  }

  const http = () => {
    const t = request(app);
    const wrap = (m: 'get' | 'post') => (url: string) =>
      t[m](url)
        .set('x-load-test-token', BYPASS)
        .set('X-Forwarded-For', `10.${crypto.randomInt(1, 255)}.${crypto.randomInt(1, 255)}.9`);
    return { get: wrap('get'), post: wrap('post') };
  };

  let a: Awaited<ReturnType<typeof mkStore>>;
  let b: Awaited<ReturnType<typeof mkStore>>;

  beforeAll(async () => {
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 4, role: 'owner' });
    await redis.connect().catch(() => undefined);
    app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use('/api/v1/payments', paymentRoutes);
    app.use(errorHandler);
    a = await mkStore('a');
    b = await mkStore('b');
  });
  afterAll(async () => {
    const orderIds = (
      await owner.order.findMany({ where: { storeId: { in: storeIds } }, select: { id: true } })
    ).map(o => o.id);
    await owner.paymentEvent
      .deleteMany({ where: { OR: [{ storeId: { in: storeIds } }, { orderId: { in: orderIds } }] } })
      .catch(() => undefined);
    await owner.payment.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => undefined);
    await owner.paymentConfig
      .deleteMany({ where: { storeId: { in: storeIds } } })
      .catch(() => undefined);
    await owner.order.deleteMany({ where: { storeId: { in: storeIds } } }).catch(() => undefined);
    await owner.store.deleteMany({ where: { id: { in: storeIds } } }).catch(() => undefined);
    await owner.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    await owner.$disconnect();
    await redis.disconnect().catch(() => undefined);
  });

  it('GET /status/:tx: owner of the right store reads it; another store and unknown get 404', async () => {
    // the provider call itself is not under test (no gateway here): the route's own store
    // resolution and ownership read are.
    const spy = vi
      .spyOn(PaymentService, 'getPaymentStatus')
      .mockResolvedValue({ status: 'completed' } as never);
    const ok = await asApp(async () =>
      http()
        .get(`/api/v1/payments/status/${a.tx}?provider=cod`)
        .set('Authorization', `Bearer ${a.jwt}`)
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.success).toBe(true);
    expect(spy).toHaveBeenCalledWith(a.tx, 'cod', a.id);

    const other = await asApp(async () =>
      http()
        .get(`/api/v1/payments/status/${a.tx}?provider=cod`)
        .set('Authorization', `Bearer ${b.jwt}`)
    );
    expect(other.status).toBe(404);

    const unknown = await asApp(async () =>
      http().get(`/api/v1/payments/status/nope-${run}`).set('Authorization', `Bearer ${a.jwt}`)
    );
    expect(unknown.status).toBe(404);
    spy.mockRestore();
  });

  it('GET /order/:id: owner gets the payment row; another store gets 404', async () => {
    const ok = await asApp(async () =>
      http().get(`/api/v1/payments/order/${a.orderId}`).set('Authorization', `Bearer ${a.jwt}`)
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.payment?.transactionId).toBe(a.tx);

    const other = await asApp(async () =>
      http().get(`/api/v1/payments/order/${a.orderId}`).set('Authorization', `Bearer ${b.jwt}`)
    );
    expect(other.status).toBe(404);
  });
});
