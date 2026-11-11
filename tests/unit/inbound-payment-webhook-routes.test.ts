/**
 * INBOUND payment-provider webhooks (apps/api/src/routes/webhook.routes.ts): the route-level
 * checks that must survive any change to merchant OUTGOING webhooks (security review 2026-10-21).
 * Goes red if the missing-signature refusal, the replay short-circuit, the store-ownership check
 * or the "persist the raw body + signature before acting" step is removed. The signature VALUE is
 * verified downstream with the merchant's secret (inbound-payment-webhook-integrity.test.ts and the
 * per-gateway contract tests).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const m = vi.hoisted(() => ({
  findOrder: vi.fn(),
  resolveStore: vi.fn(),
  inboxRecord: vi.fn(),
  inboxUpdate: vi.fn(),
  inngestSend: vi.fn(),
  handleWebhook: vi.fn(),
  verify: vi.fn(),
  incr: vi.fn(),
  getStatus: vi.fn(),
  storeFind: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  runInTenantContext: async (_s: string, fn: () => unknown) => fn(),
  withStore: async (_s: string, fn: () => unknown) => fn(),
  prisma: { store: { findUnique: m.storeFind } },
  Prisma: {},
}));
vi.mock('@api/lib/definer', () => ({
  findOrderByIdempotencyKey: m.findOrder,
  getOrderStoreId: vi.fn(),
  getStorefrontForPaymentRef: vi.fn(),
  storefrontForStoreId: m.storeFind,
  resolveStoreFromWebhookRef: m.resolveStore,
  webhookInbox: { record: m.inboxRecord, update: m.inboxUpdate },
}));
vi.mock('@api/services/payment-providers/payment.factory', () => ({
  PaymentService: {
    handleWebhook: m.handleWebhook,
    getPaymentStatus: m.getStatus,
    verifyWebhookDelivery: m.verify,
  },
}));
vi.mock('@api/middleware/security', () => ({ auditLog: m.audit }));
const alerts = vi.hoisted(() => ({ sendAlert: vi.fn() }));
vi.mock('@api/services/alerts.service', () => ({
  sendAlert: (...a: unknown[]) => (alerts.sendAlert(...a), Promise.resolve(undefined)),
}));
vi.mock('@api/services/redis.service', () => ({ redis: { incrementRateLimit: m.incr } }));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: m.inngestSend } }));
vi.mock('@api/services/shipping-carrier.service', () => ({ shippingCarrierService: {} }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const STORE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const paymob = {
  body: {
    type: 'TRANSACTION',
    obj: { id: 77, success: true, order: { id: 'po1', merchant_order_id: 'm1' } },
  },
  signed: (r: request.Test) => r.query({ hmac: 'abc123' }),
  unsigned: (r: request.Test) => r,
};
const kashier = {
  body: { data: { merchantOrderId: 'k1', status: 'SUCCESS', transactionId: 't1' } },
  signed: (r: request.Test) => r.set('x-kashier-signature', 'abc123'),
  unsigned: (r: request.Test) => r,
};
const fawry = {
  signedBody: {
    fawryRefNumber: 'f1',
    merchantRefNumber: 'fm1',
    orderStatus: 'PAID',
    messageSignature: 'abc123',
  },
  body: { fawryRefNumber: 'f1', merchantRefNumber: 'fm1', orderStatus: 'PAID' },
  signed: (r: request.Test) => r,
  unsigned: (r: request.Test) => r,
};

const cases = [
  { provider: 'paymob', ...paymob, sendBody: paymob.body },
  { provider: 'kashier', ...kashier, sendBody: kashier.body },
  { provider: 'fawry', ...fawry, sendBody: fawry.signedBody },
] as const;

let app: Express;
beforeAll(async () => {
  const { default: routes } = await import('@api/routes/webhook.routes');
  const server = express();
  server.use('/api/v1/webhooks', express.raw({ type: 'application/json' }), routes);
  server.use(((err: any, _req: any, res: any, _next: any) =>
    res.status(err.statusCode ?? 500).json({ error: err.message })) as express.ErrorRequestHandler);
  app = server;
});
beforeEach(() => {
  Object.values(m).forEach(f => f.mockReset());
  m.findOrder.mockResolvedValue(null);
  m.resolveStore.mockResolvedValue(STORE);
  m.inboxRecord.mockResolvedValue('evt-row-1');
  m.inngestSend.mockResolvedValue({ ids: ['x'] });
  m.audit.mockResolvedValue(undefined);
  m.verify.mockResolvedValue({});
  m.incr.mockResolvedValue(1);
});

const post = (c: (typeof cases)[number], path: string, signed: boolean) => {
  const r = request(app).post(`/api/v1/webhooks${path}`).set('content-type', 'application/json');
  const body = signed ? c.sendBody : c.body;
  return (signed ? c.signed(r) : c.unsigned(r)).send(JSON.stringify(body));
};

describe.each(cases)('inbound $provider webhook route', c => {
  const path = `/payment/${c.provider}`;

  it('refuses an unsigned delivery with 401 and touches nothing', async () => {
    const res = await post(c, path, false);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE'); // the one constant body (WEBHOOK-ORDER-1)
    expect(m.findOrder).not.toHaveBeenCalled();
    expect(m.resolveStore).not.toHaveBeenCalled(); // before ANY lookup
    expect(m.audit).not.toHaveBeenCalled();
    expect(m.inboxRecord).not.toHaveBeenCalled();
    expect(m.inngestSend).not.toHaveBeenCalled();
    expect(m.handleWebhook).not.toHaveBeenCalled();
  });

  it('rejects a non-JSON body with 400 before anything else', async () => {
    const res = await request(app)
      .post(`/api/v1/webhooks${path}`)
      .set('content-type', 'application/json')
      .send('not json{');
    expect(res.status).toBe(400);
    expect(m.inboxRecord).not.toHaveBeenCalled();
  });

  it('replay: an already-processed delivery is acknowledged and NOT processed again', async () => {
    m.findOrder.mockResolvedValue({
      orderId: 'o1',
      storeId: STORE,
      webhookProcessedAt: new Date(),
    });
    const res = await post(c, path, true);
    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe('Webhook already processed');
    expect(m.inboxRecord).not.toHaveBeenCalled();
    expect(m.inngestSend).not.toHaveBeenCalled();
    expect(m.handleWebhook).not.toHaveBeenCalled();
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'WEBHOOK_DUPLICATE' }));
  });

  const badSig = () =>
    m.verify.mockRejectedValue(
      Object.assign(new Error('Invalid webhook signature'), {
        statusCode: 400,
        code: 'INVALID_SIGNATURE',
      })
    );

  it('WEBHOOK-ORDER-1: a bad signature on a KNOWN payment and on an UNKNOWN payment are byte-identical 401s, on both URL shapes', async () => {
    badSig();
    for (const p of [path, `${path}/s/${STORE}`]) {
      m.resolveStore.mockResolvedValue(STORE);
      const known = await post(c, p, true);
      m.resolveStore.mockResolvedValue(null);
      const unknown = await post(c, p, true);
      m.resolveStore.mockResolvedValue(OTHER);
      const otherStore = await post(c, p, true);
      const unsigned = await post(c, p, false);
      for (const r of [known, unknown, otherStore, unsigned]) {
        expect(r.status).toBe(401);
        expect(r.text).toBe(known.text);
      }
    }
    expect(m.inboxRecord).not.toHaveBeenCalled();
    expect(m.inngestSend).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('WEBHOOK-ORDER-1: on the per-store URL the signature is checked BEFORE any payment lookup', async () => {
    badSig();
    await post(c, `${path}/s/${STORE}`, true);
    expect(m.verify).toHaveBeenCalledWith(
      c.provider,
      expect.anything(),
      expect.any(String),
      STORE,
      expect.any(String)
    );
    expect(m.resolveStore).not.toHaveBeenCalled();
    expect(m.findOrder).not.toHaveBeenCalled();
  });

  it('WEBHOOK-ORDER-1 / M-050: a VALID signature on an unknown payment answers 503 + Retry-After and stores nothing', async () => {
    m.resolveStore.mockResolvedValue(null);
    const res = await post(c, `${path}/s/${STORE}`, true);
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('60');
    expect(res.body.error.code).toBe('PAYMENT_NOT_YET_VISIBLE');
    expect(m.inboxRecord).not.toHaveBeenCalled();
    expect(m.inngestSend).not.toHaveBeenCalled();
  });

  it('WEBHOOK-ORDER-1: a valid store-A signature with a store-B ref is byte-identical to an unknown ref (no cross-store oracle)', async () => {
    m.resolveStore.mockResolvedValue(null);
    const unknown = await post(c, `${path}/s/${STORE}`, true);
    m.resolveStore.mockResolvedValue(OTHER);
    const otherStore = await post(c, `${path}/s/${STORE}`, true);
    expect(unknown.status).toBe(503);
    expect(otherStore.status).toBe(503);
    expect(otherStore.text).toBe(unknown.text);
    expect(otherStore.headers['retry-after']).toBe(unknown.headers['retry-after']);
    expect(m.inboxRecord).not.toHaveBeenCalled();
    expect(m.inngestSend).not.toHaveBeenCalled();
  });

  it('WEBHOOK-SCOPE-1: the same ref in two stores resolves only inside the signed store', async () => {
    // Both stores hold this ref; the resolver is asked for the URL store and must be told to prefer it.
    m.resolveStore.mockImplementation(
      async (a: { preferStoreId?: string | null }) => a.preferStoreId ?? OTHER
    );
    const res = await post(c, `${path}/s/${STORE}`, true);
    expect(res.status).toBe(200);
    expect(m.resolveStore).toHaveBeenCalledWith(
      expect.objectContaining({ provider: c.provider, preferStoreId: STORE })
    );
    expect(m.inboxRecord).toHaveBeenCalledWith(expect.objectContaining({ storeId: STORE }));
  });

  it('WEBHOOK-SCOPE-1: a cross-store ref is refused (503, nothing stored, nothing enqueued)', async () => {
    m.resolveStore.mockResolvedValue(OTHER);
    const res = await post(c, `${path}/s/${STORE}`, true);
    expect(res.status).toBe(503);
    expect(m.inboxRecord).not.toHaveBeenCalled();
    expect(m.inngestSend).not.toHaveBeenCalled();
    expect(m.handleWebhook).not.toHaveBeenCalled();
  });

  it('WEBHOOK-SCOPE-1: an order another store already settled under the same key is NOT a duplicate here', async () => {
    m.findOrder.mockResolvedValue({
      orderId: 'oB',
      storeId: OTHER,
      webhookProcessedAt: new Date(),
    });
    const res = await post(c, `${path}/s/${STORE}`, true);
    expect(res.status).toBe(200);
    expect(res.body.data.message).not.toBe('Webhook already processed');
    expect(m.inboxRecord).toHaveBeenCalledWith(expect.objectContaining({ storeId: STORE }));
  });

  it('WEBHOOK-SCOPE-1: the delivery is stored and deduped under a store-prefixed key', async () => {
    await post(c, `${path}/s/${STORE}`, true);
    expect(m.findOrder.mock.calls[0][0]).toMatch(new RegExp(`^${STORE}:`));
    expect(m.inboxRecord.mock.calls[0][0].idempotencyKey).toMatch(new RegExp(`^${STORE}:`));
  });

  it('WEBHOOK-ORDER-1: a VALID signature on a known payment answers 200', async () => {
    const res = await post(c, `${path}/s/${STORE}`, true);
    expect(res.status).toBe(200);
    expect(m.inboxRecord).toHaveBeenCalled();
  });

  it('SEC-5 timing: bad signature, unknown payment and wrong store each take at least the floor', async () => {
    const { REJECT_FLOOR_MS } = await import('@api/routes/webhook.routes');
    m.verify.mockRejectedValue(
      Object.assign(new Error('Invalid webhook signature'), {
        statusCode: 400,
        code: 'INVALID_SIGNATURE',
      })
    );
    const timed = async (go: () => Promise<{ status: number }>) => {
      const t0 = Date.now();
      const r = await go();
      expect(r.status).toBe(401);
      return Date.now() - t0;
    };
    const slack = 15; // timer granularity
    const bad = await timed(() => post(c, path, true));
    m.resolveStore.mockResolvedValue(null);
    const unknown = await timed(() => post(c, path, true));
    m.resolveStore.mockResolvedValue(OTHER);
    const wrong = await timed(() => post(c, `${path}/s/${STORE}`, true));
    for (const ms of [bad, unknown, wrong])
      expect(ms).toBeGreaterThanOrEqual(REJECT_FLOOR_MS - slack);
  });

  it('SEC-5 oracle: an unknown payment still costs one HMAC (constant-cost dummy verify)', async () => {
    const spy = vi.spyOn((await import('node:crypto')).default, 'createHmac');
    m.resolveStore.mockResolvedValue(null);
    await post(c, path, true);
    expect(spy).toHaveBeenCalledWith('sha256', 'ebda-webhook-dummy-key');
    // and the same Redis counter write the real failure path makes, on a dummy key
    expect(m.incr).toHaveBeenCalledWith('payment-hmac-fail:dummy', 300);
    spy.mockRestore();
  });

  it('SEC-5: a delivery whose signature does not verify gets 401 (so a genuine gateway retries) and stores/queues nothing', async () => {
    m.verify.mockRejectedValue(
      Object.assign(new Error('Invalid webhook signature'), {
        statusCode: 400,
        code: 'INVALID_SIGNATURE',
      })
    );
    const res = await post(c, path, true);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    expect(m.verify).toHaveBeenCalledWith(
      c.provider,
      expect.anything(),
      expect.any(String),
      STORE,
      JSON.stringify(c.sendBody)
    );
    expect(m.inboxRecord).not.toHaveBeenCalled();
    expect(m.inngestSend).not.toHaveBeenCalled();
    expect(m.handleWebhook).not.toHaveBeenCalled();
    // failures are counted per store and source
    expect(m.incr).toHaveBeenCalledWith(expect.stringMatching(/^webhook-sigfail:/), 300);
    // a forged body learns nothing about processed payments and writes no audit row
    m.findOrder.mockResolvedValue({
      orderId: 'o1',
      storeId: STORE,
      webhookProcessedAt: new Date(),
    });
    const again = await post(c, path, true);
    expect(again.status).toBe(401);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('SEC-5: past the per-source budget the answer is 429, still a retry signal, still nothing stored', async () => {
    m.verify.mockRejectedValue(
      Object.assign(new Error('Invalid webhook signature'), {
        statusCode: 400,
        code: 'INVALID_SIGNATURE',
      })
    );
    m.incr.mockResolvedValue(21);
    const res = await post(c, path, true);
    expect(res.status).toBe(429);
    expect(m.inboxRecord).not.toHaveBeenCalled();
    expect(m.inngestSend).not.toHaveBeenCalled();
  });

  it('SEC-5: a transient verification failure (not a client error) is a 5xx so the gateway retries', async () => {
    m.verify.mockRejectedValue(Object.assign(new Error('db down'), { statusCode: 503 }));
    const res = await post(c, path, true);
    expect(res.status).toBe(503);
    expect(m.inboxRecord).not.toHaveBeenCalled();
    expect(m.inngestSend).not.toHaveBeenCalled();
  });

  it('a fresh signed delivery persists the raw body + signature and enqueues; the signature is verified downstream', async () => {
    const res = await post(c, path, true);
    expect(res.status).toBe(200);
    expect(m.inboxRecord).toHaveBeenCalledWith(
      expect.objectContaining({ provider: c.provider, storeId: STORE, signature: 'abc123' })
    );
    expect(m.inboxRecord.mock.calls[0][0].rawBody).toBe(JSON.stringify(c.sendBody));
    expect(m.inngestSend).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'payment/webhook.received' })
    );
  });
});

describe('legacy-keyed Paymob replay is a no-op on EVERY entry path', () => {
  const child = {
    type: 'TRANSACTION',
    obj: {
      id: 88,
      success: true,
      pending: false,
      is_refunded: false,
      is_voided: false,
      has_parent_transaction: true,
      order: { id: 'po1', merchant_order_id: 'm1' },
    },
  };
  const legacyKey = 'paymob_88_0100'; // pre-PR shape: paymob_<id>_<pending success voided refunded>

  it.each(['/payment/paymob', `/payment/paymob/s/${STORE}`, '/payment'])(
    'POST %s dedupes on the stored legacy key',
    async path => {
      m.findOrder.mockImplementation(async (k: string) =>
        k === legacyKey ? { orderId: 'o1', storeId: STORE, webhookProcessedAt: new Date() } : null
      );
      const res = await request(app)
        .post(`/api/v1/webhooks${path}`)
        .set('content-type', 'application/json')
        .query({ hmac: 'abc123' })
        .send(JSON.stringify(child));
      expect(res.status).toBe(200);
      expect(res.body.data.message).toBe('Webhook already processed');
      expect(m.inboxRecord).not.toHaveBeenCalled();
      expect(m.handleWebhook).not.toHaveBeenCalled();
    }
  );
});

describe('store resolution stays inside the delivering provider (Ruling ITEST-14)', () => {
  it.each(cases)(
    '$provider: the resolver is asked for that provider, with no URL store on the bare route',
    async c => {
      await post(c, `/payment/${c.provider}`, true);
      expect(m.resolveStore).toHaveBeenCalledWith(
        expect.objectContaining({ provider: c.provider, preferStoreId: null })
      );
    }
  );

  it.each(cases)('$provider: the per-store URL names its store as the preferred owner', async c => {
    await post(c, `/payment/${c.provider}/s/${STORE}`, true);
    expect(m.resolveStore).toHaveBeenCalledWith(
      expect.objectContaining({ provider: c.provider, preferStoreId: STORE })
    );
  });
});

describe('payment callback redirect (GET /payment/callback)', () => {
  const SLUG = { slug: 'shop-a', domain: null };
  beforeEach(() => {
    m.getStatus.mockResolvedValue({ status: 'completed' });
    m.storeFind.mockResolvedValue(SLUG);
  });

  it.each([
    ['order', 'paymob'],
    ['merchantOrderId', 'kashier'],
    ['merchantRefNumber', 'fawry'],
  ] as const)(
    '?%s= resolves the owning store within %s, once, for status AND storefront',
    async (param, provider) => {
      const res = await request(app).get(`/api/v1/webhooks/payment/callback?${param}=ref-1`);
      expect(res.status).toBe(302);
      expect(m.resolveStore).toHaveBeenCalledTimes(1);
      expect(m.resolveStore).toHaveBeenCalledWith({ transactionId: 'ref-1', provider });
      // the status read and the storefront come from the SAME store
      // within the provider the store was resolved for (no storeless / Postgres lookup of the provider)
      expect(m.getStatus).toHaveBeenCalledWith('ref-1', provider, STORE);
      expect(m.storeFind).toHaveBeenCalledWith(STORE);
      expect(res.headers.location).toContain('/checkout/success');
      expect(res.headers.location).toContain('shop-a');
    }
  );

  it('an unknown reference falls back to the platform web URL', async () => {
    m.resolveStore.mockResolvedValue(null);
    m.getStatus.mockResolvedValue({ status: 'pending' });
    const res = await request(app).get('/api/v1/webhooks/payment/callback?order=ref-2');
    expect(res.status).toBe(302);
    expect(m.storeFind).not.toHaveBeenCalled();
    // no store: no status read at all (it could only be a Postgres lookup), the pending page polls
    expect(m.getStatus).not.toHaveBeenCalled();
    expect(res.headers.location).toContain('/checkout/pending');
  });
});

describe('Ruling FAWRY-REFUND-DEDUPE-1: a repeated Fawry refund notice through the signed route raises a P1', () => {
  const refund = (over: Record<string, unknown> = {}) => ({
    fawryRefNumber: 'f1',
    merchantRefNumber: 'fm1',
    orderStatus: 'PARTIALLY_REFUNDED',
    paymentAmount: '200.00',
    messageSignature: 'abc123',
    ...over,
  });
  const send = (body: Record<string, unknown>) =>
    request(app)
      .post('/api/v1/webhooks/payment/fawry')
      .set('content-type', 'application/json')
      .send(JSON.stringify(body));

  it.each([
    ['with no reference number', {}],
    [
      'WITH a reference number (nothing proves it changes per refund)',
      { paymentRefrenceNumber: 'RF-1' },
    ],
  ])('%s: still acked 200, not processed, and a P1 names the order', async (_n, over) => {
    alerts.sendAlert.mockClear();
    m.findOrder.mockResolvedValue({
      orderId: 'o1',
      storeId: STORE,
      webhookProcessedAt: new Date(),
    });
    const res = await send(refund(over));
    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe('Webhook already processed');
    expect(m.verify).toHaveBeenCalled(); // the delivery was authenticated before the duplicate check
    expect(m.handleWebhook).not.toHaveBeenCalled();
    expect(alerts.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'p1',
        source: 'payment.webhook.fawry_refund_repeat',
        context: expect.objectContaining({
          merchantRefNumber: 'fm1',
          orderStatus: 'PARTIALLY_REFUNDED',
        }),
      })
    );
  });

  it('a repeated Fawry PAYMENT notice raises nothing; an unsigned refund notice is refused before any alert', async () => {
    alerts.sendAlert.mockClear();
    m.findOrder.mockResolvedValue({
      orderId: 'o1',
      storeId: STORE,
      webhookProcessedAt: new Date(),
    });
    await send(refund({ orderStatus: 'PAID' }));
    expect(alerts.sendAlert).not.toHaveBeenCalled();
    const { messageSignature: _s, ...unsigned } = refund();
    const res = await send(unsigned);
    expect(res.status).toBe(401);
    expect(alerts.sendAlert).not.toHaveBeenCalled();
  });
});
