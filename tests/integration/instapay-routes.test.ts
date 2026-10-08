/**
 * InstaPay over HTTP (SP6a): the checkout create/read/reference endpoints and the
 * merchant's confirm endpoint, mounted as in production, with the code under test
 * bound to a real `ebda_app` login (strict RLS, no bypass).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { createPrismaClient, runWithRequestDb, type AppPrismaClient } from '@force/database';
import { config } from '@api/config';
import { inngest } from '@api/lib/inngest/client';
import { OneSignalService } from '@api/services/onesignal.service';
import paymentRoutes from '@api/routes/payment.routes';
import orderRoutes from '@api/routes/order.routes';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import { tenantContext } from '@api/middleware/tenant-context';
import { errorHandler } from '@api/middleware/error-handler';
import { planService } from '@api/services/plan.service';
import { redis } from '@api/services/redis.service';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const hasDb = !!OWNER_URL && !OWNER_URL.includes('localhost:5432/test_db');
const run = crypto.randomUUID().slice(0, 8);
// POST /payments/* is limited to 10 per minute per IP; the API's own load-test bypass skips it.
const BYPASS = `ipr-bypass-${run}`;
process.env.LOAD_TEST_BYPASS_TOKEN = BYPASS;
const HOUR = 3_600_000;
const TOTAL = 12_345;

function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return u.toString();
}
/** Bind everything the request touches (the route handlers, the services) to an ebda_app login. */
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn, {
    // Post-commit work (the fan-out of a confirm) runs on this client: let it finish first.
    beforeDisconnect: () => awaitDeferredWork(5000),
  });

const token = (userId: string) =>
  jwt.sign(
    { userId, email: `${userId}@example.test`, role: 'store_admin', tv: 0 },
    config.jwtSecret,
    {
      expiresIn: '30m',
      issuer: 'force-api',
      audience: 'force-app',
    }
  );

describe.skipIf(!hasDb)('InstaPay over HTTP', () => {
  let owner: AppPrismaClient;
  let app: Express;
  const stores: Array<{ id: string; userId: string; jwt: string }> = [];
  let orderSeq = 0;

  async function mkStore(tag: string, instapay = true) {
    const user = await owner.user.create({
      data: {
        email: `ipr-${tag}-${run}@test.local`,
        passwordHash: 'x',
        firstName: 'Ip',
        lastName: tag,
        role: 'store_admin',
        emailVerified: true,
      },
    });
    const store = await owner.store.create({
      data: {
        name: `ipr-${tag}-${run}`,
        slug: `ipr-${tag}-${run}`,
        ownerId: user.id,
        status: 'active',
      },
    });
    await planService.assignPlan(store.id, { planCode: 'comped' });
    const product = await owner.product.create({
      data: {
        storeId: store.id,
        name: 'Tee',
        slug: `tee-${tag}-${run}`,
        price: TOTAL,
        inventory: 20,
        status: 'active',
      },
    });
    if (instapay) {
      await owner.paymentConfig.create({
        data: {
          storeId: store.id,
          provider: 'instapay',
          isEnabled: true,
          displayName: 'InstaPay',
          settings: { handle: 'amelia@instapay', phone: '01012345678', expiryHours: 48 },
        },
      });
    }
    await owner.paymentConfig.create({
      data: { storeId: store.id, provider: 'cod', isEnabled: true, fixedFee: 500 },
    });
    const s = { id: store.id, userId: user.id, jwt: token(user.id), productId: product.id };
    stores.push(s);
    return s;
  }

  // `codFee`: a COD order is created with its fee frozen and inside total (MONEYB-3).
  async function mkOrder(s: { id: string; productId: string }, codFee = 0) {
    orderSeq += 1;
    return owner.order.create({
      data: {
        storeId: s.id,
        orderNumber: `IPR-${run}-${orderSeq}`,
        status: 'pending',
        paymentStatus: 'unpaid',
        subtotal: TOTAL,
        codFee,
        total: TOTAL + codFee,
        shippingAddress: { firstName: 'Mona', lastName: 'Adel', email: 'mona@example.com' },
        billingAddress: {},
        items: {
          create: [
            { productId: s.productId, productName: 'Tee', quantity: 1, price: TOTAL, total: TOTAL },
          ],
        },
      },
    });
  }

  const http = () => {
    const t = request(app);
    const wrap = (m: 'get' | 'post' | 'put') => (url: string) =>
      t[m](url).set('x-load-test-token', BYPASS);
    return { get: wrap('get'), post: wrap('post'), put: wrap('put') };
  };
  const auth = (j: string) => ({ Authorization: `Bearer ${j}` });
  const create = (orderId: string, provider: string) =>
    asApp(async () => http().post('/api/v1/payments/create').send({ orderId, provider }));
  const confirm = (s: { id: string; jwt: string }, orderId: string) =>
    asApp(async () =>
      http().post(`/api/v1/stores/${s.id}/orders/${orderId}/confirm-instapay`).set(auth(s.jwt))
    );

  beforeAll(async () => {
    vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 4, role: 'owner' });
    await redis.connect().catch(() => undefined);
    app = express();
    app.use(express.json());
    app.use('/api/v1/payments', paymentRoutes);
    app.use('/api/v1/stores/:storeId/orders', tenantContext, orderRoutes);
    app.use(errorHandler);
  });

  afterAll(async () => {
    const ids = stores.map(s => s.id);
    await owner.paymentEvent.deleteMany({ where: { storeId: { in: ids } } }).catch(() => undefined);
    await owner.orderEvent.deleteMany({ where: { storeId: { in: ids } } }).catch(() => undefined);
    await owner.payment
      .deleteMany({ where: { order: { storeId: { in: ids } } } })
      .catch(() => undefined);
    await owner.orderItem
      .deleteMany({ where: { order: { storeId: { in: ids } } } })
      .catch(() => undefined);
    await owner.auditLog.deleteMany({ where: { storeId: { in: ids } } }).catch(() => undefined);
    await owner.order.deleteMany({ where: { storeId: { in: ids } } }).catch(() => undefined);
    await owner.paymentConfig
      .deleteMany({ where: { storeId: { in: ids } } })
      .catch(() => undefined);
    await owner.product.deleteMany({ where: { storeId: { in: ids } } }).catch(() => undefined);
    await owner.store.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
    await owner.user
      .deleteMany({ where: { id: { in: stores.map(s => s.userId) } } })
      .catch(() => undefined);
    await owner.$disconnect();
    await redis.disconnect().catch(() => undefined);
  });

  it('POST /payments/create (instapay) returns handle, phone, exact amount and reference, and holds the order', async () => {
    vi.spyOn(OneSignalService, 'notifyAdminsOfInstapay').mockResolvedValue();
    const s = await mkStore('create');
    const o = await mkOrder(s);
    const res = await create(o.id, 'instapay');
    expect(res.status).toBe(200);
    expect(res.body.data.provider).toBe('instapay');
    expect(res.body.data.instapay).toMatchObject({
      handle: 'amelia@instapay',
      phone: '01012345678',
      amountMinor: TOTAL,
      reference: o.orderNumber,
    });
    const after = await owner.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(after.status).toBe('awaiting_payment_confirmation');
    expect(after.paymentStatus).toBe('unpaid');

    // a replay shows the same thing and creates nothing
    const again = await create(o.id, 'instapay');
    expect(again.status).toBe(200);
    expect(again.body.data.transactionId).toBe(res.body.data.transactionId);
    expect(await owner.payment.count({ where: { orderId: o.id } })).toBe(1);

    // the customer's page can be reloaded
    const view = await asApp(async () => http().get(`/api/v1/payments/instapay/${o.id}`));
    expect(view.status).toBe(200);
    expect(view.body.data.orderStatus).toBe('awaiting_payment_confirmation');
    expect(view.body.data.instructions.amountMinor).toBe(TOTAL);
  });

  it('the typed transfer reference is retired: 410 RECEIPT_REQUIRED (the screenshot is the proof)', async () => {
    const s = await mkStore('ref');
    const o = await mkOrder(s);
    await create(o.id, 'instapay');
    const res = await asApp(async () =>
      http()
        .post(`/api/v1/payments/instapay/${o.id}/reference`)
        .send({ reference: 'IPN-20261004-77' })
    );
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('RECEIPT_REQUIRED');
  });

  it('GET /payments/config offers InstaPay (name and window only: the handle is not shown to every visitor) next to COD', async () => {
    const s = await mkStore('cfg');
    const res = await asApp(async () =>
      http().get('/api/v1/payments/config').set('x-store-id', s.id)
    );
    expect(res.status).toBe(200);
    expect(res.body.data.instapay).toMatchObject({ displayName: 'InstaPay', expiryHours: 48 });
    expect(res.body.data.cod).toMatchObject({ fixedFee: 500 });
    expect(JSON.stringify(res.body)).not.toContain('amelia@instapay');
    expect(JSON.stringify(res.body)).not.toContain('01012345678');
  });

  it('a store without InstaPay refuses it and keeps the order pending', async () => {
    const s = await mkStore('off', false);
    const o = await mkOrder(s);
    const res = await create(o.id, 'instapay');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INSTAPAY_NOT_AVAILABLE');
    expect((await owner.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('pending');
  });

  it('COD is untouched: same fee, same payment row, order stays pending', async () => {
    const s = await mkStore('cod');
    const o = await mkOrder(s, 500);
    const res = await create(o.id, 'cod');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ provider: 'cod', cod: true, codFee: 500 });
    const after = await owner.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(after.total).toBe(TOTAL + 500);
    expect(after.status).toBe('pending');
    const [p] = await owner.payment.findMany({ where: { orderId: o.id } });
    expect(p).toMatchObject({ provider: 'cod', status: 'cod_pending', amount: TOTAL + 500 });
  });

  describe('POST /stores/:storeId/orders/:orderId/confirm-instapay', () => {
    it('confirms once; a second tap is an idempotent 200 with changed:false', async () => {
      vi.spyOn(OneSignalService, 'notifyAdminsOfInstapay').mockResolvedValue();
      const s = await mkStore('conf');
      const o = await mkOrder(s);
      await create(o.id, 'instapay');
      const first = await confirm(s, o.id);
      expect(first.status).toBe(200);
      expect(first.body.data).toMatchObject({ changed: true, status: 'confirmed' });
      const second = await confirm(s, o.id);
      expect(second.status).toBe(200);
      expect(second.body.data).toMatchObject({ changed: false, status: 'confirmed' });
      const after = await owner.order.findUniqueOrThrow({ where: { id: o.id } });
      expect(after).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' });
      expect(
        await owner.orderEvent.count({ where: { orderId: o.id, toStatus: 'confirmed' } })
      ).toBe(1);
    });

    it('is refused after the window expired, and the order stays unpaid', async () => {
      vi.spyOn(OneSignalService, 'notifyAdminsOfInstapay').mockResolvedValue();
      const s = await mkStore('exp');
      const o = await mkOrder(s);
      await create(o.id, 'instapay');
      await owner.order.update({
        where: { id: o.id },
        data: { paymentConfirmationExpiresAt: new Date(Date.now() - HOUR) },
      });
      const res = await confirm(s, o.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INSTAPAY_CONFIRMATION_EXPIRED');
      expect((await owner.order.findUniqueOrThrow({ where: { id: o.id } })).paymentStatus).toBe(
        'unpaid'
      );
    });

    it('needs a signed-in merchant of THAT store', async () => {
      vi.spyOn(OneSignalService, 'notifyAdminsOfInstapay').mockResolvedValue();
      const a = await mkStore('acc-a');
      const b = await mkStore('acc-b');
      const o = await mkOrder(a);
      await create(o.id, 'instapay');
      const anon = await asApp(async () =>
        http().post(`/api/v1/stores/${a.id}/orders/${o.id}/confirm-instapay`)
      );
      expect(anon.status).toBe(401);
      const other = await confirm({ id: a.id, jwt: b.jwt }, o.id);
      expect([403, 404]).toContain(other.status);
      expect((await owner.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe(
        'awaiting_payment_confirmation'
      );
    });

    it('the generic status route cannot ship an awaiting order', async () => {
      vi.spyOn(OneSignalService, 'notifyAdminsOfInstapay').mockResolvedValue();
      const s = await mkStore('ship');
      const o = await mkOrder(s);
      await create(o.id, 'instapay');
      const res = await asApp(async () =>
        http()
          .put(`/api/v1/stores/${s.id}/orders/${o.id}/status`)
          .set(auth(s.jwt))
          .send({ status: 'shipped' })
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    });

    it('the order list filters to "awaiting InstaPay confirmation"', async () => {
      vi.spyOn(OneSignalService, 'notifyAdminsOfInstapay').mockResolvedValue();
      const s = await mkStore('list');
      const held = await mkOrder(s);
      await mkOrder(s); // stays pending
      await create(held.id, 'instapay');
      const res = await asApp(async () =>
        http()
          .get(`/api/v1/stores/${s.id}/orders`)
          .query({ status: 'awaiting_payment_confirmation' })
          .set(auth(s.jwt))
      );
      expect(res.status).toBe(200);
      const orders = (res.body.data.orders ?? res.body.data) as Array<{
        id: string;
        status: string;
      }>;
      expect(orders.map(o => o.id)).toEqual([held.id]);
    });
  });
});
