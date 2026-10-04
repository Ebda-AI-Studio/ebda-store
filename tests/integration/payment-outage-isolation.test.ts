/**
 * Provider outage isolation (SP6a, Review Focus 5) and "no external call inside a
 * request transaction", against a real Postgres with the code under test bound to
 * a real `ebda_app` login.
 *
 *   - a gateway that times out disables ONLY that method, for ONLY that store;
 *   - checkout keeps offering COD and InstaPay and they keep working;
 *   - the merchant sees the health (circuit + persisted `health_status`);
 *   - the provider is called with NO transaction open (create order -> commit ->
 *     call provider -> short transaction to record).
 *
 * Mutation proof (commit body): put the provider call back inside
 * `runInTenantContext` in routes/payment.routes.ts -> "the provider is called with
 * no transaction open" goes red.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  createPrismaClient,
  hasTenantContext,
  runWithRequestDb,
  type AppPrismaClient,
} from '@force/database';

const h = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'hang' | 'reject',
  calls: 0,
  ambientTxAtCall: [] as boolean[],
}));

// The MyFatoorah adapter is replaced by one that can hang, reject or succeed, and
// records whether a transaction was open at the moment it was called.
vi.mock('@api/services/payment-providers/myfatoorah.provider', async () => {
  const { hasTenantContext: inTx } = await import('@force/database');
  const { ProviderRejectedError } = await import('@api/services/payment-providers/refund-outcome');
  return {
    MyFatoorahPaymentProvider: class {
      name = 'myfatoorah';
      initialize = () => undefined;
      createPayment = async (req: { orderId: string; amount: number }) => {
        h.calls += 1;
        h.ambientTxAtCall.push(inTx());
        if (h.mode === 'hang') await new Promise(() => undefined);
        if (h.mode === 'reject') throw new ProviderRejectedError('invalid email', 400);
        return {
          success: true,
          provider: 'myfatoorah',
          transactionId: `mf-${req.orderId.slice(0, 8)}`,
          invoiceId: 'inv-1',
          paymentUrl: 'https://pay.test/inv-1',
        };
      };
    },
  };
});

import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import { config } from '@api/config';
import { encryption } from '@api/services/encryption.service';
import { OneSignalService } from '@api/services/onesignal.service';
import { PaymentService } from '@api/services/payment-providers/payment.factory';
import { resetProviderHealthForTests } from '@api/services/payment-providers/provider-health';
import paymentRoutes from '@api/routes/payment.routes';
import paymentSettingsRoutes from '@api/routes/payment-settings.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { planService } from '@api/services/plan.service';
import { redis } from '@api/services/redis.service';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const hasDb = !!OWNER_URL && !OWNER_URL.includes('localhost:5432/test_db');
const run = crypto.randomUUID().slice(0, 8);
const BYPASS = `outage-bypass-${run}`;
process.env.LOAD_TEST_BYPASS_TOKEN = BYPASS;
process.env.PAYMENT_PROVIDER_TIMEOUT_MS = '60';
const TOTAL = 12_345;

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

describe.skipIf(!hasDb)('provider outage isolation', () => {
  let owner: AppPrismaClient;
  let app: Express;
  const stores: Array<{ id: string; userId: string; productId: string; jwt: string }> = [];
  let seq = 0;

  async function mkStore(tag: string) {
    const user = await owner.user.create({
      data: {
        email: `out-${tag}-${run}@test.local`,
        passwordHash: 'x',
        firstName: 'O',
        lastName: tag,
        role: 'store_admin',
        emailVerified: true,
      },
    });
    const store = await owner.store.create({
      data: {
        name: `out-${tag}-${run}`,
        slug: `out-${tag}-${run}`,
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
        inventory: 50,
        status: 'active',
      },
    });
    await owner.paymentConfig.createMany({
      data: [
        {
          storeId: store.id,
          provider: 'myfatoorah',
          isEnabled: true,
          isDefault: true,
          apiKey: encryption.encrypt('mf-key'),
        },
        { storeId: store.id, provider: 'cod', isEnabled: true, fixedFee: 500 },
        {
          storeId: store.id,
          provider: 'instapay',
          isEnabled: true,
          settings: { handle: 'out@instapay', expiryHours: 48 },
        },
      ],
    });
    const s = {
      id: store.id,
      userId: user.id,
      productId: product.id,
      jwt: jwt.sign(
        { userId: user.id, email: `${user.id}@example.test`, role: 'store_admin', tv: 0 },
        config.jwtSecret,
        {
          expiresIn: '30m',
          issuer: 'force-api',
          audience: 'force-app',
        }
      ),
    };
    stores.push(s);
    return s;
  }

  async function mkOrder(s: { id: string; productId: string }) {
    seq += 1;
    return owner.order.create({
      data: {
        storeId: s.id,
        orderNumber: `OUT-${run}-${seq}`,
        status: 'pending',
        paymentStatus: 'unpaid',
        subtotal: TOTAL,
        total: TOTAL,
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
    // A fresh client IP per request: the card-testing guard budgets attempts per IP in Redis.
    const wrap = (m: 'get' | 'post') => (url: string) =>
      t[m](url)
        .set('x-load-test-token', BYPASS)
        .set(
          'X-Forwarded-For',
          `10.${crypto.randomInt(1, 255)}.${crypto.randomInt(1, 255)}.${crypto.randomInt(1, 255)}`
        );
    return { get: wrap('get'), post: wrap('post') };
  };
  const create = (orderId: string, provider: string) =>
    asApp(async () => http().post('/api/v1/payments/create').send({ orderId, provider }));
  const checkoutConfig = (s: { id: string }) =>
    asApp(async () => http().get('/api/v1/payments/config').set('x-store-id', s.id));

  beforeAll(async () => {
    vi.spyOn(OneSignalService, 'notifyAdminsOfInstapay').mockResolvedValue();
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 4 });
    await redis.connect().catch(() => undefined);
    app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use('/api/v1/payments', paymentRoutes);
    app.use('/api/v1/payment-settings', paymentSettingsRoutes);
    app.use(errorHandler);
  });
  beforeEach(() => {
    h.mode = 'ok';
    h.calls = 0;
    h.ambientTxAtCall = [];
    resetProviderHealthForTests();
    PaymentService.clearCache();
    vi.spyOn(OneSignalService, 'notifyAdminsOfInstapay').mockResolvedValue();
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

  it('the provider is called with NO transaction open, then the payment is recorded', async () => {
    const s = await mkStore('notx');
    const o = await mkOrder(s);
    const res = await create(o.id, 'myfatoorah');
    expect(res.status).toBe(200);
    expect(res.body.data.paymentUrl).toBe('https://pay.test/inv-1');
    expect(h.calls).toBe(1);
    expect(h.ambientTxAtCall).toEqual([false]); // nothing was holding a transaction open
    expect(hasTenantContext()).toBe(false);
    const [p] = await owner.payment.findMany({ where: { orderId: o.id } });
    expect(p).toMatchObject({ provider: 'myfatoorah', status: 'pending', amount: TOTAL });
  });

  it('a hanging gateway times out as a 503 and records NO payment', async () => {
    const s = await mkStore('hang1');
    const o = await mkOrder(s);
    h.mode = 'hang';
    const res = await create(o.id, 'myfatoorah');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
    expect(await owner.payment.count({ where: { orderId: o.id } })).toBe(0);
  });

  it('three outages disable ONLY that method for THAT store; COD and InstaPay keep working; other stores are unaffected', async () => {
    const a = await mkStore('iso-a');
    const b = await mkStore('iso-b');
    h.mode = 'hang';
    for (let i = 0; i < 3; i += 1) {
      const o = await mkOrder(a);
      expect((await create(o.id, 'myfatoorah')).status).toBe(503);
    }
    expect(h.calls).toBe(3);

    // The 4th does not even call the provider: it fails fast.
    const fast = await mkOrder(a);
    const t0 = Date.now();
    const res = await create(fast.id, 'myfatoorah');
    expect(res.status).toBe(503);
    expect(h.calls).toBe(3);
    expect(Date.now() - t0).toBeLessThan(2_000);

    // Checkout config: the gateway is hidden for A, COD and InstaPay are still offered.
    const cfgA = await checkoutConfig(a);
    expect(cfgA.status).toBe(200);
    expect(cfgA.body.data.providers).not.toContain('myfatoorah');
    expect(cfgA.body.data.unavailable).toContain('myfatoorah');
    expect(cfgA.body.data.cod).toMatchObject({ fixedFee: 500 });
    expect(cfgA.body.data.instapay).toMatchObject({ expiryHours: 48 });
    expect(cfgA.body.data.defaultProvider).not.toBe('myfatoorah');

    // COD and InstaPay on the SAME store still work.
    const codOrder = await mkOrder(a);
    const cod = await create(codOrder.id, 'cod');
    expect(cod.status).toBe(200);
    expect(cod.body.data).toMatchObject({ cod: true, codFee: 500 });
    const ipOrder = await mkOrder(a);
    const ip = await create(ipOrder.id, 'instapay');
    expect(ip.status).toBe(200);
    expect(ip.body.data.instapay).toMatchObject({ handle: 'out@instapay', amountMinor: TOTAL });

    // Another store with the same gateway is untouched.
    h.mode = 'ok';
    const cfgB = await checkoutConfig(b);
    expect(cfgB.body.data.providers).toContain('myfatoorah');
    expect(cfgB.body.data.unavailable).toEqual([]);
    const bOrder = await mkOrder(b);
    expect((await create(bOrder.id, 'myfatoorah')).status).toBe(200);
  });

  it('a gateway that REJECTS the request is not an outage: it never disables the method', async () => {
    const s = await mkStore('reject');
    h.mode = 'reject';
    for (let i = 0; i < 5; i += 1) {
      const o = await mkOrder(s);
      const res = await create(o.id, 'myfatoorah');
      expect(res.status).not.toBe(503);
    }
    const cfg = await checkoutConfig(s);
    expect(cfg.body.data.providers).toContain('myfatoorah');
    expect(cfg.body.data.unavailable).toEqual([]);
  });

  it('shows the merchant the method is down: live circuit and persisted health', async () => {
    const s = await mkStore('health');
    h.mode = 'hang';
    for (let i = 0; i < 3; i += 1) await create((await mkOrder(s)).id, 'myfatoorah');

    await vi.waitFor(async () => {
      const row = await owner.paymentConfig.findFirstOrThrow({
        where: { storeId: s.id, provider: 'myfatoorah' },
      });
      expect(row.healthStatus).toBe('down');
      expect(row.lastHealthCheck).not.toBeNull();
    });

    const list = await asApp(async () =>
      request(app)
        .get(`/api/v1/payment-settings/store/${s.id}`)
        .set('Authorization', `Bearer ${s.jwt}`)
    );
    expect(list.status).toBe(200);
    const mf = (list.body.data.storeConfigs as Array<Record<string, unknown>>).find(
      c => c.provider === 'myfatoorah'
    )!;
    expect(mf.circuit).toBe('down');
    expect(mf.healthStatus).toBe('down');
    // and the secrets are masked, not echoed
    expect(JSON.stringify(list.body)).not.toContain('mf-key');
    expect(mf.apiKey).toMatch(/^\*{4}/);
  });

  it('recovers by itself: after the cool-down the next success closes the circuit', async () => {
    const s = await mkStore('recover');
    h.mode = 'hang';
    for (let i = 0; i < 3; i += 1) await create((await mkOrder(s)).id, 'myfatoorah');
    expect((await checkoutConfig(s)).body.data.providers).not.toContain('myfatoorah');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61_000);
    try {
      h.mode = 'ok';
      const res = await create((await mkOrder(s)).id, 'myfatoorah');
      expect(res.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
    expect((await checkoutConfig(s)).body.data.providers).toContain('myfatoorah');
  });
});
