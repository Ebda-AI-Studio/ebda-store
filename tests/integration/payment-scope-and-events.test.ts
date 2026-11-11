/**
 * SP6b leftovers from 6a, against a real Postgres with the code under test bound to an
 * `ebda_app` login (strict RLS) and the REAL Paymob adapter talking to a loopback stub:
 *
 *   - a customer's payment retry asks the gateway with NO
 *     transaction open (read -> commit -> call -> short transaction to record);
 *   - GET /payments/:id/events and /events/:id/payload resolve the payment's store through the
 *     guarded definer: the payment's own store owner and super_admin see it, ANOTHER store's
 *     admin and an unknown id get 404, and the raw payload is super_admin only.
 *
 * Mutation proof: put the provider call back inside `runInTenantContext` in
 * PaymentService.createPayment -> the "NO transaction open" test goes red.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { createPrismaClient, runWithRequestDb, type AppPrismaClient } from '@ebda/database';
import { PaymobStub, PAYMOB_STUB } from '../stubs/paymob-stub';
import { serveStub, type ServedStub } from '../stubs/serve';
import { awaitDeferredWork } from '@api/lib/after-tenant-commit';
import { config } from '@api/config';
import { encryption } from '@api/services/encryption.service';
import { PaymentService } from '@api/services/payment-providers/payment.factory';
import { resetProviderHealthForTests } from '@api/services/payment-providers/provider-health';
import paymentRoutes from '@api/routes/payment.routes';
import { errorHandler } from '@api/middleware/error-handler';
import { planService } from '@api/services/plan.service';
import { redis } from '@api/services/redis.service';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const hasDb = !!OWNER_URL && !OWNER_URL.includes('localhost:5432/test_db');
const run = crypto.randomUUID().slice(0, 8);
const BYPASS = `scope-bypass-${run}`;
process.env.LOAD_TEST_BYPASS_TOKEN = BYPASS;
const TOTAL = 15_000;

const paymob = new PaymobStub();
const idleTxAtGatewayCall: number[] = [];
let paymobServer: ServedStub;

// The code under test's own connections carry this name, so the idle-transaction probe counts ONLY them: CI's serial
// lane shares the database with the API server on :4000 (also ebda_app), whose transactions are not this test's subject
// (main run 42994749985 counted 5 of them and went red with this file's code path untouched).
const APP_NAME = `scope-${run}`;
function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  u.searchParams.set('application_name', APP_NAME);
  return u.toString();
}
const asApp = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(() => createPrismaClient({ connectionString: appUrl(), max: 3 }), fn, {
    beforeDisconnect: () => awaitDeferredWork(5000),
  });
// A customer token is bound to its store (F-01, Ruling S11-1).
const token = (userId: string, role: string, storeId?: string) =>
  jwt.sign({ userId, email: `${userId}@example.test`, role, tv: 0, storeId }, config.jwtSecret, {
    expiresIn: '30m',
    issuer: 'ebda-api',
    audience: 'ebda-app',
  });

describe.skipIf(!hasDb)('payment scope: link/retry outside a tx, events definer', () => {
  let owner: AppPrismaClient;
  let app: Express;
  const storeIds: string[] = [];
  const userIds: string[] = [];

  // `uniq` per call: CI's --retry=1 re-runs a test with the same `run`, and a fixed email/slug collided (P2002), so the
  // retry could never pass and hid the first failure behind a unique-constraint error.
  let uniq = 0;
  async function mkUser(tag: string, role: 'store_admin' | 'customer' | 'super_admin') {
    const u = await owner.user.create({
      data: {
        email: `scope-${tag}-${run}-${++uniq}@test.local`,
        passwordHash: 'x',
        firstName: 'S',
        lastName: tag,
        role,
        emailVerified: true,
      },
    });
    userIds.push(u.id);
    return u;
  }

  async function mkStore(tag: string) {
    const admin = await mkUser(`adm-${tag}`, 'store_admin');
    const store = await owner.store.create({
      data: {
        name: `scope-${tag}-${run}-${++uniq}`,
        slug: `scope-${tag}-${run}-${uniq}`,
        ownerId: admin.id,
        status: 'active',
      },
    });
    storeIds.push(store.id);
    await planService.assignPlan(store.id, { planCode: 'comped' });
    const product = await owner.product.create({
      data: {
        storeId: store.id,
        name: 'Tee',
        slug: `tee-${tag}-${run}-${uniq}`,
        price: TOTAL,
        inventory: 50,
        status: 'active',
      },
    });
    await owner.paymentConfig.create({
      data: {
        storeId: store.id,
        provider: 'paymob',
        isEnabled: true,
        isDefault: true,
        apiKey: encryption.encrypt(PAYMOB_STUB.secretKey),
        webhookSecret: encryption.encrypt(PAYMOB_STUB.hmacSecret),
        settings: { publicKey: PAYMOB_STUB.publicKey, integrationIds: PAYMOB_STUB.integrationIds },
      },
    });
    return {
      id: store.id,
      adminId: admin.id,
      productId: product.id,
      jwt: token(admin.id, 'store_admin'),
    };
  }

  let seq = 0;
  async function mkPayment(
    s: { id: string; productId: string },
    customerId: string | null,
    status: 'failed' | 'pending'
  ) {
    seq += 1;
    const order = await owner.order.create({
      data: {
        storeId: s.id,
        customerId,
        orderNumber: `SCP-${run}-${seq}`,
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
    const payment = await owner.payment.create({
      data: {
        orderId: order.id,
        provider: 'paymob',
        status,
        amount: TOTAL,
        transactionId: `tx-${run}-${seq}`,
      },
    });
    return { order, payment };
  }

  const http = () => {
    const t = request(app);
    const wrap = (m: 'get' | 'post') => (url: string) =>
      t[m](url)
        .set('x-load-test-token', BYPASS)
        .set(
          'X-Forwarded-For',
          `10.${crypto.randomInt(1, 255)}.${crypto.randomInt(1, 255)}.${crypto.randomInt(1, 255)}`
        );
    return { get: wrap('get'), post: wrap('post') };
  };

  const idleAppTransactions = async (): Promise<number> => {
    const rows = await owner.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM pg_stat_activity
      WHERE usename = 'ebda_app' AND datname = current_database() AND application_name = ${APP_NAME}
        AND state = 'idle in transaction'`;
    return Number(rows[0]?.n ?? 0);
  };

  beforeAll(async () => {
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 4, role: 'owner' });
    paymobServer = await serveStub(paymob.fetch, async () => {
      idleTxAtGatewayCall.push(await idleAppTransactions());
    });
    process.env.PAYMOB_BASE_URL = paymobServer.url;
    await redis.connect().catch(() => undefined);
    app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use('/api/v1/payments', paymentRoutes);
    app.use(errorHandler);
  });
  beforeEach(() => {
    idleTxAtGatewayCall.length = 0;
    paymob.requests.length = 0;
    resetProviderHealthForTests();
    PaymentService.clearCache();
  });
  afterAll(async () => {
    const orderIds = (
      await owner.order.findMany({ where: { storeId: { in: storeIds } }, select: { id: true } })
    ).map(o => o.id);
    const byOrder = { OR: [{ storeId: { in: storeIds } }, { orderId: { in: orderIds } }] };
    await owner.paymentEvent.deleteMany({ where: byOrder }).catch(() => undefined);
    await owner.orderEvent.deleteMany({ where: byOrder }).catch(() => undefined);
    await owner.payment.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => undefined);
    await owner.orderItem
      .deleteMany({ where: { orderId: { in: orderIds } } })
      .catch(() => undefined);
    await owner.auditLog
      .deleteMany({ where: { storeId: { in: storeIds } } })
      .catch(() => undefined);
    await owner.order.deleteMany({ where: { storeId: { in: storeIds } } }).catch(() => undefined);
    await owner.paymentConfig
      .deleteMany({ where: { storeId: { in: storeIds } } })
      .catch(() => undefined);
    await owner.product.deleteMany({ where: { storeId: { in: storeIds } } }).catch(() => undefined);
    await owner.store.deleteMany({ where: { id: { in: storeIds } } }).catch(() => undefined);
    await owner.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    await owner.$disconnect();
    await redis.disconnect().catch(() => undefined);
    await paymobServer.close();
  });

  it("a customer's retry of a failed payment asks the gateway with NO transaction open", async () => {
    const s = await mkStore('retry');
    const customer = await mkUser('cust-retry', 'customer');
    const { payment } = await mkPayment(s, customer.id, 'failed');
    const res = await asApp(async () =>
      http()
        .post(`/api/v1/payments/retry/${payment.id}`)
        .set('Authorization', `Bearer ${token(customer.id, 'customer', s.id)}`)
        .send({})
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(paymob.requests.filter(r => r.path === '/v1/intention/')).toHaveLength(1);
    expect(idleTxAtGatewayCall).toEqual([0]);
  });

  describe('GET /payments/:id/events (guarded store-resolving definer)', () => {
    let a: Awaited<ReturnType<typeof mkStore>>;
    let b: Awaited<ReturnType<typeof mkStore>>;
    let payment: { id: string };
    let eventId: string;
    let superJwt: string;

    beforeAll(async () => {
      a = await mkStore('ev-a');
      b = await mkStore('ev-b');
      ({ payment } = await mkPayment(a, null, 'pending'));
      const order = await owner.payment.findUniqueOrThrow({ where: { id: payment.id } });
      const ev = await owner.paymentEvent.create({
        data: {
          paymentId: payment.id,
          storeId: a.id,
          orderId: order.orderId,
          eventType: 'webhook',
          provider: 'paymob',
          providerPayload: { secretish: 'raw-body' },
        },
      });
      eventId = ev.id;
      superJwt = token((await mkUser('super', 'super_admin')).id, 'super_admin');
    });

    const getEvents = (id: string, jwtToken: string) =>
      asApp(async () =>
        http().get(`/api/v1/payments/${id}/events`).set('Authorization', `Bearer ${jwtToken}`)
      );
    const getPayload = (id: string, jwtToken: string) =>
      asApp(async () =>
        http()
          .get(`/api/v1/payments/events/${id}/payload`)
          .set('Authorization', `Bearer ${jwtToken}`)
      );

    it("the payment's own store admin and super_admin read the events; the list omits the raw payload", async () => {
      for (const t of [a.jwt, superJwt]) {
        const res = await getEvents(payment.id, t);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body.data.events).toHaveLength(1);
        expect(res.body.data.events[0].providerPayload).toBeUndefined();
      }
    });

    it("another store's admin, and an unknown id, get 404 (no existence oracle)", async () => {
      const other = await getEvents(payment.id, b.jwt);
      const unknown = await getEvents(crypto.randomUUID(), b.jwt);
      expect(other.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(other.body).toEqual(unknown.body);
    });

    it('the raw payload is super_admin only; a store admin is 403, another id 404', async () => {
      expect((await getPayload(eventId, a.jwt)).status).toBe(403);
      const ok = await getPayload(eventId, superJwt);
      expect(ok.status).toBe(200);
      expect(ok.body.data.providerPayload).toEqual({ secretish: 'raw-body' });
      expect((await getPayload(crypto.randomUUID(), superJwt)).status).toBe(404);
    });
  });
});
