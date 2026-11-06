/**
 * SP5 task 4 - card-testing guard on storefront online payments.
 *
 * Real Redis (REDIS_URL), real guard, real `POST /payments/create` route with
 * the gateway / DB mocked. Provider-agnostic: nothing here names a gateway
 * beyond passing a provider string through.
 *
 * Mutation proofs (recorded in the commit body):
 *   1. services/card-testing-guard.service.ts: delete the `provider === 'cod'`
 *      early return -> "COD is never counted or blocked" fails.
 *   2. same file: raise the session threshold comparison (`>=` -> `>`) -> "blocks
 *      a session after N declines" fails (the Nth decline does not block).
 *   3. same file: drop the per-payment `NX` dedupe -> "a replayed webhook does
 *      not double-count a decline" fails.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import crypto from 'crypto';

const h = vi.hoisted(() => ({
  rollbackCalls: [] as unknown[][],
  orderFindFirst: vi.fn(),
  paymentFindFirst: vi.fn(),
  paymentCreate: vi.fn(),
  paymentConfigFindFirst: vi.fn(),
  createPayment: vi.fn(),
  storeFindUnique: vi.fn(),
  sendAlert: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  // tests/setup-e2e.ts builds the owner-role fixture client from this export;
  // these suites never touch a database, so a stub is enough.
  createPrismaClient: vi.fn(),
  prisma: {
    order: { findFirst: (...a: unknown[]) => h.orderFindFirst(...a), update: vi.fn() },
    payment: {
      findFirst: (...a: unknown[]) => h.paymentFindFirst(...a),
      create: (...a: unknown[]) => h.paymentCreate(...a),
    },
    paymentConfig: { findFirst: (...a: unknown[]) => h.paymentConfigFindFirst(...a) },
    store: { findUnique: (...a: unknown[]) => h.storeFindUnique(...a) },
  },
  runInTenantContext: async (_s: string, fn: () => unknown) => fn(),
  // The store row is read in the store's own scope (withStore passes its tx).
  withStore: async (_s: string, fn: (tx: unknown) => unknown) =>
    fn({ store: { findUnique: (...a: unknown[]) => h.storeFindUnique(...a) } }),
}));
// The route resolves the order's store through a SECURITY DEFINER lookup, then reads inside that scope.
vi.mock('@api/lib/definer', () => ({ getOrderStoreId: async () => 'store-from-order' }));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (_req: any, _res: any, next: any) => next(),
  optionalAuthenticate: (_req: any, _res: any, next: any) => next(),
  // POST /payments/create mounts rejectImpersonated (no payment from an impersonation session).
  rejectImpersonated: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/rbac', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({
  paymentLimiter: (_req: any, _res: any, next: any) => next(),
  // payment.routes mounts the InstaPay receipt upload behind both (#51).
  uploadLimiter: (_req: any, _res: any, next: any) => next(),
  dailyUploadLimiter: (_req: any, _res: any, next: any) => next(),
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@api/utils/store-helpers', () => ({ getAuthUser: (req: any) => req.user }));
vi.mock('@api/services/payment-providers/payment.factory', () => ({
  // The route calls the provider in two halves (no transaction open during the call).
  PaymentService: {
    requestProviderPayment: async (...a: unknown[]) => ({
      providerName: 'kashier',
      response: await h.createPayment(...a),
    }),
    recordProviderPayment: vi.fn().mockResolvedValue(undefined),
    // the COD row (+ its created event) is written by the service (NEON-ZERO: one DO section on a Durable Object store)
    recordCodPayment: async (...a: unknown[]) => ({
      id: ((await h.paymentCreate(...a)) as { id: string }).id,
      replayed: false,
    }),
    getDefaultProvider: async () => 'kashier',
    getAvailableProviders: async () => [],
  },
}));
vi.mock('@api/services/payment-providers/orphaned-invoice-alert', () => ({
  alertOrphanedProviderInvoice: vi.fn(),
}));
vi.mock('@api/services/payment-event.service', () => ({ recordPaymentEvent: vi.fn() }));
vi.mock('@api/services/order.service', () => ({
  OrderService: {
    rollbackForPaymentFailure: async (...a: unknown[]) => {
      h.rollbackCalls.push(a);
    },
  },
}));
vi.mock('@api/services/alerts.service', () => ({
  sendAlert: (...a: unknown[]) => h.sendAlert(...a),
}));

import { CardTestingGuard } from '@api/services/card-testing-guard.service';
import { redis } from '@api/services/redis.service';
import { errorHandler } from '@api/middleware/error-handler';

const uid = () => crypto.randomUUID();
const run = crypto.randomUUID().slice(0, 8);
/** A unique store / IP per test so Redis buckets never leak between tests or runs. */
let n = 0;
const freshStore = () => `store-${run}-${n++}`;
// Random per call: the counters live in Redis for up to an hour across runs.
const freshIp = () =>
  `10.${crypto.randomInt(1, 255)}.${crypto.randomInt(1, 255)}.${crypto.randomInt(1, 255)}`;
const ctx = (over: Partial<Parameters<typeof CardTestingGuard.assertAllowed>[0]> = {}) => ({
  storeId: freshStore(),
  orderId: uid(),
  provider: 'kashier',
  ip: freshIp(),
  sessionId: `sess-${uid()}`,
  ...over,
});

beforeAll(async () => {
  await redis.connect();
  expect(redis.isAvailable()).toBe(true);
});
afterAll(async () => {
  await redis.disconnect();
});
beforeEach(() => {
  h.sendAlert.mockReset().mockResolvedValue('sent');
  h.storeFindUnique.mockReset().mockResolvedValue({ id: 's', name: 'Amelia', slug: 'amelia' });
});
afterEach(() => {
  for (const k of [
    'PAYMENT_ATTEMPTS_PER_IP_10M',
    'PAYMENT_ATTEMPTS_PER_STORE_10M',
    'PAYMENT_SESSION_MAX_DECLINES',
    'PAYMENT_IP_MAX_DECLINES',
    'PAYMENT_ALERT_MIN_ATTEMPTS',
    'PAYMENT_ALERT_DECLINE_RATIO',
  ]) {
    delete process.env[k];
  }
});

const allowed = async (c: ReturnType<typeof ctx>) =>
  CardTestingGuard.assertAllowed(c).then(
    () => true,
    (e: { code?: string }) => e.code ?? 'ERR'
  );

describe('attempt budgets', () => {
  it('per-IP: the 11th online attempt in 10 minutes is refused; another IP is fine', async () => {
    const ip = freshIp();
    const store = freshStore();
    for (let i = 0; i < 10; i++) {
      expect(await allowed(ctx({ ip, storeId: store }))).toBe(true);
    }
    expect(await allowed(ctx({ ip, storeId: store }))).toBe('PAYMENT_RATE_LIMITED');
    expect(await allowed(ctx({ ip: freshIp(), storeId: store }))).toBe(true);
  });

  it('per-IP budget is configurable', async () => {
    process.env.PAYMENT_ATTEMPTS_PER_IP_10M = '2';
    const ip = freshIp();
    expect(await allowed(ctx({ ip }))).toBe(true);
    expect(await allowed(ctx({ ip }))).toBe(true);
    expect(await allowed(ctx({ ip }))).toBe('PAYMENT_RATE_LIMITED');
  });

  it('per-store: many IPs against ONE store hit the store budget; another store is unaffected', async () => {
    process.env.PAYMENT_ATTEMPTS_PER_STORE_10M = '5';
    const store = freshStore();
    for (let i = 0; i < 5; i++) {
      expect(await allowed(ctx({ storeId: store, ip: freshIp() }))).toBe(true);
    }
    expect(await allowed(ctx({ storeId: store, ip: freshIp() }))).toBe('PAYMENT_RATE_LIMITED');
    expect(await allowed(ctx({ storeId: freshStore(), ip: freshIp() }))).toBe(true);
  });

  it('IPv6 clients are bucketed by /64', async () => {
    process.env.PAYMENT_ATTEMPTS_PER_IP_10M = '1';
    const block = `2001:db8:${crypto.randomBytes(2).toString('hex')}:${crypto.randomBytes(2).toString('hex')}`;
    expect(await allowed(ctx({ ip: `${block}::1` }))).toBe(true);
    expect(await allowed(ctx({ ip: `${block}:1:2:3:4` }))).toBe('PAYMENT_RATE_LIMITED');
  });
});

describe('COD is unaffected', () => {
  it('is never counted or blocked, even for a blocked IP / store at budget', async () => {
    process.env.PAYMENT_ATTEMPTS_PER_IP_10M = '1';
    const ip = freshIp();
    const store = freshStore();
    expect(await allowed(ctx({ ip, storeId: store }))).toBe(true);
    expect(await allowed(ctx({ ip, storeId: store }))).toBe('PAYMENT_RATE_LIMITED');
    for (let i = 0; i < 20; i++) {
      expect(await allowed(ctx({ ip, storeId: store, provider: 'cod' }))).toBe(true);
    }
  });
});

describe('per-session decline counter', () => {
  async function declineN(
    base: ReturnType<typeof ctx>,
    count: number
  ): Promise<ReturnType<typeof ctx>> {
    // Each declined attempt is a fresh order on the same session / IP.
    for (let i = 0; i < count; i++) {
      const c = { ...base, orderId: uid() };
      expect(await allowed(c)).toBe(true);
      const r = await CardTestingGuard.recordDecline({
        storeId: c.storeId,
        orderId: c.orderId,
        paymentId: uid(),
      });
      expect(r.counted).toBe(true);
    }
    return base;
  }

  it('blocks a session after N (default 5) declines, not before', async () => {
    process.env.PAYMENT_ATTEMPTS_PER_IP_10M = '1000';
    const base = ctx();
    await declineN(base, 4);
    expect(await allowed({ ...base, orderId: uid() })).toBe(true); // 4 declines: still allowed
    await declineN(base, 1); // the 5th decline
    expect(await allowed({ ...base, orderId: uid() })).toBe('PAYMENT_BLOCKED');
  });

  it('the threshold is configurable and another session is not blocked', async () => {
    process.env.PAYMENT_SESSION_MAX_DECLINES = '2';
    process.env.PAYMENT_ATTEMPTS_PER_IP_10M = '1000';
    const base = ctx();
    await declineN(base, 2);
    expect(await allowed({ ...base, orderId: uid() })).toBe('PAYMENT_BLOCKED');
    expect(
      await allowed({ ...base, orderId: uid(), sessionId: `sess-${uid()}`, ip: freshIp() })
    ).toBe(true);
  });

  it('rotating the session id from the same IP does not escape the per-IP decline block', async () => {
    process.env.PAYMENT_IP_MAX_DECLINES = '3';
    process.env.PAYMENT_ATTEMPTS_PER_IP_10M = '1000';
    const ip = freshIp();
    const store = freshStore();
    for (let i = 0; i < 3; i++) {
      await declineN(ctx({ ip, storeId: store }), 1); // a NEW session every time
    }
    expect(await allowed(ctx({ ip, storeId: store }))).toBe('PAYMENT_BLOCKED');
  });

  it('a replayed webhook does not double-count a decline', async () => {
    process.env.PAYMENT_SESSION_MAX_DECLINES = '2';
    process.env.PAYMENT_ATTEMPTS_PER_IP_10M = '1000';
    const base = ctx();
    expect(await allowed(base)).toBe(true);
    const paymentId = uid();
    const first = await CardTestingGuard.recordDecline({
      storeId: base.storeId,
      orderId: base.orderId,
      paymentId,
    });
    const replay = await CardTestingGuard.recordDecline({
      storeId: base.storeId,
      orderId: base.orderId,
      paymentId,
    });
    expect([first.counted, replay.counted]).toEqual([true, false]);
    // Only ONE decline recorded -> below the threshold of 2 -> still allowed.
    expect(await allowed({ ...base, orderId: uid() })).toBe(true);
  });
});

describe('decline-rate alert', () => {
  async function attemptAndDecline(storeId: string, declined: boolean) {
    const c = ctx({ storeId });
    process.env.PAYMENT_ATTEMPTS_PER_IP_10M = '1000';
    await CardTestingGuard.assertAllowed(c);
    if (declined) {
      return CardTestingGuard.recordDecline({ storeId, orderId: c.orderId, paymentId: uid() });
    }
    return null;
  }

  it('alerts (once) when a store crosses the decline ratio with enough attempts', async () => {
    process.env.PAYMENT_ALERT_MIN_ATTEMPTS = '10';
    process.env.PAYMENT_ALERT_DECLINE_RATIO = '0.5';
    process.env.PAYMENT_ATTEMPTS_PER_STORE_10M = '1000';
    const store = freshStore();
    for (let i = 0; i < 10; i++) await attemptAndDecline(store, true);
    expect(h.sendAlert).toHaveBeenCalledTimes(1);
    const arg = h.sendAlert.mock.calls[0][0];
    expect(arg).toMatchObject({
      level: 'p1',
      scope: 'store',
      source: 'payment.card_testing.decline_spike',
    });
    expect(arg.store).toMatchObject({ id: store, name: 'Amelia' });
    // Further declines in the same hour do not re-alert.
    await attemptAndDecline(store, true);
    expect(h.sendAlert).toHaveBeenCalledTimes(1);
  });

  it('does not alert below the minimum sample, nor when the rate is healthy', async () => {
    process.env.PAYMENT_ALERT_MIN_ATTEMPTS = '10';
    process.env.PAYMENT_ATTEMPTS_PER_STORE_10M = '1000';
    const small = freshStore();
    for (let i = 0; i < 5; i++) await attemptAndDecline(small, true); // 100% but only 5 attempts
    expect(h.sendAlert).not.toHaveBeenCalled();

    const healthy = freshStore();
    for (let i = 0; i < 20; i++) await attemptAndDecline(healthy, i < 2); // 10% declined
    expect(h.sendAlert).not.toHaveBeenCalled();
  });
});

describe('POST /payments/create wiring', () => {
  const ORDER_ID = '11111111-1111-4111-8111-111111111111';
  let app: Express;

  beforeAll(async () => {
    const { default: router } = await import('@api/routes/payment.routes');
    app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use('/api/v1/payments', router);
    app.use(errorHandler);
  });
  beforeEach(() => {
    h.rollbackCalls = [];
    h.orderFindFirst.mockResolvedValue({
      id: ORDER_ID,
      storeId: freshStore(),
      orderNumber: 'ORD-1',
      status: 'pending',
      total: 5000,
      walletAmount: 0,
      currency: 'EGP',
      items: [],
      customer: null,
      shippingAddress: { email: 'g@example.com' },
      store: { domain: null, slug: 'demo' },
      // Created through OrderService.create, which admits a manual (COD/InstaPay) hold;
      // without the marker the #65 guard answers 409 MANUAL_HOLD_NOT_ADMITTED (FU46-9 class).
      manualHoldAdmitted: true,
    });
    h.paymentFindFirst.mockResolvedValue(null);
    h.paymentCreate.mockResolvedValue({ id: 'pay-1' });
    h.paymentConfigFindFirst.mockResolvedValue({ fixedFee: 0 });
    h.createPayment.mockResolvedValue({
      transactionId: 'txn-1',
      paymentUrl: 'https://gw.test/pay',
      provider: 'kashier',
    });
  });

  const create = (provider: string, ip: string) =>
    request(app)
      .post('/api/v1/payments/create')
      .set('x-session-id', 'sess-route')
      .set('X-Forwarded-For', ip)
      .send({ orderId: ORDER_ID, provider });

  it('refuses an online attempt over budget with 429, never calls the gateway, rolls the order back', async () => {
    process.env.PAYMENT_ATTEMPTS_PER_IP_10M = '2';
    const ip = freshIp();
    expect((await create('kashier', ip)).status).toBe(200);
    expect((await create('kashier', ip)).status).toBe(200);
    h.createPayment.mockClear();
    const res = await create('kashier', ip);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('PAYMENT_RATE_LIMITED');
    expect(h.createPayment).not.toHaveBeenCalled();
    expect(h.rollbackCalls).toHaveLength(1); // cart / stock restored
  });

  it('COD through the same route is unaffected by an exhausted budget', async () => {
    process.env.PAYMENT_ATTEMPTS_PER_IP_10M = '1';
    const ip = freshIp();
    expect((await create('kashier', ip)).status).toBe(200);
    expect((await create('kashier', ip)).status).toBe(429);
    const cod = await create('cod', ip);
    expect(cod.status).toBe(200);
    expect(cod.body.data.cod).toBe(true);
  });
});
