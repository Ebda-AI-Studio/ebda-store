/**
 * Provider outage isolation (SP6a, Review Focus 5) and "no external call inside a
 * request transaction", against a real Postgres with the code under test bound to
 * a real `ebda_app` login, and the REAL Paymob and Kashier adapters talking to local
 * gateway stubs over loopback HTTP (SP6b).
 *
 *   - Paymob down (hung, refused) disables ONLY Paymob, for ONLY that store;
 *   - checkout keeps offering Kashier, COD and InstaPay and they keep working;
 *   - the merchant sees the health (circuit + persisted `health_status`);
 *   - the gateway is asked with NO transaction open: at the moment the stub receives the
 *     call, no `ebda_app` session is `idle in transaction` (create order -> commit -> call
 *     provider -> short transaction to record).
 *
 * Mutation proof (commit body): put the provider call back inside `runInTenantContext` in
 * routes/payment.routes.ts -> "the gateway is asked with NO transaction open" goes red.
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
} from '@ebda/database';
import { KashierStub, KASHIER_STUB } from '../stubs/kashier-stub';
import { PaymobStub, PAYMOB_STUB } from '../stubs/paymob-stub';
import { serveStub, type ServedStub } from '../stubs/serve';

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

const paymob = new PaymobStub();
const kashier = new KashierStub();
/** Open `ebda_app` transactions seen at the moment each gateway call arrived. */
const idleTxAtGatewayCall: number[] = [];
let paymobServer: ServedStub;
let kashierServer: ServedStub;

// The CI Postgres is SHARED with every other integration file running in parallel, so counting every `ebda_app`
// session that is `idle in transaction` also counted other files' open transactions (it failed #529's run). This
// file's own request connections carry a unique application_name and the count is scoped to it.
const APP_NAME = `payment-outage-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
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
          provider: 'paymob',
          isEnabled: true,
          isDefault: true,
          apiKey: encryption.encrypt(PAYMOB_STUB.secretKey),
          webhookSecret: encryption.encrypt(PAYMOB_STUB.hmacSecret),
          settings: {
            publicKey: PAYMOB_STUB.publicKey,
            integrationIds: PAYMOB_STUB.integrationIds,
          },
        },
        {
          storeId: store.id,
          provider: 'kashier',
          isEnabled: true,
          merchantId: encryption.encrypt(KASHIER_STUB.merchantId),
          apiKey: encryption.encrypt(KASHIER_STUB.apiKey),
          secretKey: encryption.encrypt(KASHIER_STUB.secretKey),
          settings: { methods: ['card', 'wallet'], display: 'en' },
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
          issuer: 'ebda-api',
          audience: 'ebda-app',
        }
      ),
    };
    stores.push(s);
    return s;
  }

  // `codFee`: a COD order is created with its fee frozen and inside total (MONEYB-3).
  async function mkOrder(
    s: { id: string; productId: string },
    codFee = 0,
    manualHoldAdmitted = false
  ) {
    seq += 1;
    return owner.order.create({
      data: {
        storeId: s.id,
        orderNumber: `OUT-${run}-${seq}`,
        status: 'pending',
        paymentStatus: 'unpaid',
        subtotal: TOTAL,
        codFee,
        manualHoldAdmitted,
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

  /** How many of THIS file's `ebda_app` sessions (by application_name) are `idle in transaction` right now. */
  const idleAppTransactions = async (): Promise<number> => {
    const rows = await owner.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM pg_stat_activity
      WHERE usename = 'ebda_app' AND application_name = ${APP_NAME}
        AND datname = current_database() AND state = 'idle in transaction'`;
    return Number(rows[0]?.n ?? 0);
  };

  beforeAll(async () => {
    vi.spyOn(OneSignalService, 'notifyAdminsOfInstapay').mockResolvedValue();
    owner = createPrismaClient({ connectionString: OWNER_URL, max: 4, role: 'owner' });
    const record = async () => {
      idleTxAtGatewayCall.push(await idleAppTransactions());
    };
    paymobServer = await serveStub(paymob.fetch, record);
    kashierServer = await serveStub(kashier.fetch, record);
    process.env.PAYMOB_BASE_URL = paymobServer.url;
    process.env.KASHIER_BASE_URL = kashierServer.url;
    await redis.connect().catch(() => undefined);
    app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use('/api/v1/payments', paymentRoutes);
    app.use('/api/v1/payment-settings', paymentSettingsRoutes);
    app.use(errorHandler);
  });
  beforeEach(() => {
    paymob.faults.down = null;
    kashier.faults.down = null;
    idleTxAtGatewayCall.length = 0;
    paymob.requests.length = 0;
    kashier.requests.length = 0;
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
    await paymobServer.close();
    await kashierServer.close();
  });

  it('the gateway is asked with NO transaction open, then the payment is recorded', async () => {
    const s = await mkStore('notx');
    const o = await mkOrder(s);
    const res = await create(o.id, 'paymob');
    expect(res.status).toBe(200);
    // Paymob's documented Egypt unified checkout host (developers.paymob.com, unified-checkout-redirection).
    expect(res.body.data.paymentUrl).toMatch(/^https:\/\/eg\.checkout\.paymob\.com\/\?publicKey=/);
    // The gateway was called once, and when it was, no ebda_app session was holding a transaction
    // open (the request's own would show up as `idle in transaction` while it waited).
    expect(paymob.requests.filter(r => r.path === '/v1/intention/')).toHaveLength(1);
    expect(idleTxAtGatewayCall).toEqual([0]);
    expect(hasTenantContext()).toBe(false);
    const [p] = await owner.payment.findMany({ where: { orderId: o.id } });
    expect(p).toMatchObject({ provider: 'paymob', status: 'pending', amount: TOTAL });
    // The wire amount is the piastre integer, not a converted number.
    expect(paymob.requests.find(r => r.path === '/v1/intention/')?.body.amount).toBe(TOTAL);
  });

  it('a hanging Paymob times out as a 503 and records NO payment', async () => {
    const s = await mkStore('hang1');
    const o = await mkOrder(s);
    paymob.faults.down = 'timeout';
    const res = await create(o.id, 'paymob');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PAYMENT_METHOD_UNAVAILABLE');
    expect(await owner.payment.count({ where: { orderId: o.id } })).toBe(0);
  });

  it('Paymob down: checkout still offers Kashier, COD and InstaPay, and they work; other stores are unaffected', async () => {
    const a = await mkStore('iso-a');
    const b = await mkStore('iso-b');
    paymob.faults.down = 'timeout';
    for (let i = 0; i < 3; i += 1) {
      const o = await mkOrder(a);
      expect((await create(o.id, 'paymob')).status).toBe(503);
    }
    const intentions = () => paymob.requests.filter(r => r.path === '/v1/intention/').length;
    expect(intentions()).toBe(3);

    // The 4th does not even call the gateway: it fails fast.
    const fast = await mkOrder(a);
    const t0 = Date.now();
    const res = await create(fast.id, 'paymob');
    expect(res.status).toBe(503);
    expect(intentions()).toBe(3);
    expect(Date.now() - t0).toBeLessThan(2_000);

    // Checkout config: Paymob is hidden for A; Kashier, COD and InstaPay are still offered.
    const cfgA = await checkoutConfig(a);
    expect(cfgA.status).toBe(200);
    expect(cfgA.body.data.providers).not.toContain('paymob');
    expect(cfgA.body.data.providers).toContain('kashier');
    expect(cfgA.body.data.unavailable).toContain('paymob');
    expect(cfgA.body.data.methods.kashier.map((m: { code: string }) => m.code)).toEqual([
      'card',
      'wallet',
    ]);
    expect(cfgA.body.data.cod).toMatchObject({ fixedFee: 500 });
    expect(cfgA.body.data.instapay).toMatchObject({ expiryHours: 48 });
    expect(cfgA.body.data.defaultProvider).not.toBe('paymob');

    // Kashier, COD and InstaPay on the SAME store still work.
    const kOrder = await mkOrder(a);
    const k = await create(kOrder.id, 'kashier');
    expect(k.status).toBe(200);
    expect(k.body.data.paymentUrl).toContain('payments.kashier.stub/session/');
    const codOrder = await mkOrder(a, 500, true);
    const cod = await create(codOrder.id, 'cod');
    expect(cod.status).toBe(200);
    expect(cod.body.data).toMatchObject({ cod: true, codFee: 500 });
    const ipOrder = await mkOrder(a, 0, true);
    const ip = await create(ipOrder.id, 'instapay');
    expect(ip.status).toBe(200);
    expect(ip.body.data.instapay).toMatchObject({ handle: 'out@instapay', amountMinor: TOTAL });

    // Another store with the same gateway is untouched.
    paymob.faults.down = null;
    const cfgB = await checkoutConfig(b);
    expect(cfgB.body.data.providers).toContain('paymob');
    expect(cfgB.body.data.unavailable).toEqual([]);
    const bOrder = await mkOrder(b);
    expect((await create(bOrder.id, 'paymob')).status).toBe(200);
  });

  it('a gateway that REFUSES the request is not an outage: it never disables the method', async () => {
    const s = await mkStore('reject');
    paymob.faults.down = 'rejected';
    for (let i = 0; i < 5; i += 1) {
      const o = await mkOrder(s);
      const res = await create(o.id, 'paymob');
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('PAYMENT_PROVIDER_ERROR');
    }
    const cfg = await checkoutConfig(s);
    expect(cfg.body.data.providers).toContain('paymob');
    expect(cfg.body.data.unavailable).toEqual([]);
  });

  it('shows the merchant the method is down: live circuit and persisted health', async () => {
    const s = await mkStore('health');
    paymob.faults.down = 'timeout';
    for (let i = 0; i < 3; i += 1) await create((await mkOrder(s)).id, 'paymob');

    await vi.waitFor(async () => {
      const row = await owner.paymentConfig.findFirstOrThrow({
        where: { storeId: s.id, provider: 'paymob' },
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
    const pm = (list.body.data.storeConfigs as Array<Record<string, unknown>>).find(
      c => c.provider === 'paymob'
    )!;
    expect(pm.circuit).toBe('down');
    expect(pm.healthStatus).toBe('down');
    // and the secrets are masked, not echoed
    expect(JSON.stringify(list.body)).not.toContain(PAYMOB_STUB.secretKey);
    expect(JSON.stringify(list.body)).not.toContain(PAYMOB_STUB.hmacSecret);
    expect(pm.apiKey).toMatch(/^\*{4}/);
    expect(pm.webhookSecret).toBe('****');
  });

  it('recovers by itself: after the cool-down the next success closes the circuit', async () => {
    const s = await mkStore('recover');
    paymob.faults.down = 'timeout';
    for (let i = 0; i < 3; i += 1) await create((await mkOrder(s)).id, 'paymob');
    expect((await checkoutConfig(s)).body.data.providers).not.toContain('paymob');

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61_000);
    try {
      paymob.faults.down = null;
      const res = await create((await mkOrder(s)).id, 'paymob');
      expect(res.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
    expect((await checkoutConfig(s)).body.data.providers).toContain('paymob');
  });
});
