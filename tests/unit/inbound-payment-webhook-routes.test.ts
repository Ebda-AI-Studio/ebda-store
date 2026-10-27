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
  resolveStoreFromWebhookRef: m.resolveStore,
  webhookInbox: { record: m.inboxRecord, update: m.inboxUpdate },
}));
vi.mock('@api/services/payment-providers/payment.factory', () => ({
  PaymentService: { handleWebhook: m.handleWebhook, getPaymentStatus: m.getStatus },
}));
vi.mock('@api/middleware/security', () => ({ auditLog: m.audit }));
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
    expect(res.body.error.code).toBe('MISSING_SIGNATURE');
    expect(m.findOrder).not.toHaveBeenCalled();
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
    m.findOrder.mockResolvedValue({ orderId: 'o1', webhookProcessedAt: new Date() });
    const res = await post(c, path, true);
    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe('Webhook already processed');
    expect(m.inboxRecord).not.toHaveBeenCalled();
    expect(m.inngestSend).not.toHaveBeenCalled();
    expect(m.handleWebhook).not.toHaveBeenCalled();
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'WEBHOOK_DUPLICATE' }));
  });

  it('a payment no store owns is ignored (200) without persisting or processing', async () => {
    m.resolveStore.mockResolvedValue(null);
    const res = await post(c, path, true);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ignored');
    expect(m.inboxRecord).not.toHaveBeenCalled();
    expect(m.inngestSend).not.toHaveBeenCalled();
  });

  it('per-store URL: a payment that belongs to ANOTHER store is ignored', async () => {
    m.resolveStore.mockResolvedValue(OTHER);
    const res = await post(c, `${path}/s/${STORE}`, true);
    expect(res.body.data.status).toBe('ignored');
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
        k === legacyKey ? { orderId: 'o1', webhookProcessedAt: new Date() } : null
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
      expect(m.getStatus).toHaveBeenCalledWith('ref-1', undefined, STORE);
      expect(m.storeFind).toHaveBeenCalledWith(expect.objectContaining({ where: { id: STORE } }));
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
    expect(res.headers.location).toContain('/checkout/pending');
  });
});
