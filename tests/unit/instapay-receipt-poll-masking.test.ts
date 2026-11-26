/**
 * G54 money review of #978 (PII): the receipt poll unmasks the payer's name / address / mobile / bank ONLY for the order's
 * view token (a header, SEC-15). The signed order-status link is a bearer URL that is forwarded in WhatsApp, so it may open
 * instructions + upload + submit, but its holder still gets the masked receipt.
 * Driver proven: the real payment router on express with the receipt service and the order->store lookup stubbed (no DO,
 * no D1). The DO nested-payments read behind `InstapayService.getReceipt` is covered by tests/integration/instapay-receipts.test.ts
 * and workers-test/money-path.test.ts, not here.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const STORE = '33333333-3333-4333-8333-333333333333';
const ORDER = '11111111-1111-4111-8111-111111111111';
const RECEIPT = '44444444-4444-4444-8444-444444444444';
const payer = {
  amountMinor: 12_345,
  reference: '987654',
  payerName: 'Mona Hassan',
  payerAddress: 'mona@instapay',
  payerMobile: '01001234567',
  payerBank: 'CIB',
};

vi.mock('@api/middleware/security', async () => {
  const pass = (_q: unknown, _s: unknown, next: () => void) => next();
  const actual = await vi.importActual<Record<string, unknown>>('@api/middleware/security');
  return new Proxy(actual, {
    get: (t, k: string) => (/limiter|Limiter/.test(k) ? pass : (t as Record<string, unknown>)[k]),
  });
});
vi.mock('@api/lib/definer', async () => ({
  ...(await vi.importActual<object>('@api/lib/definer')),
  getOrderStoreId: async (id: string) => (id === ORDER ? STORE : null),
}));
vi.mock('@api/services/payment-providers/instapay.service', async () => ({
  ...(await vi.importActual<object>('@api/services/payment-providers/instapay.service')),
  InstapayService: {
    getReceipt: async () => ({
      id: RECEIPT,
      flags: [],
      extracted: { ...payer },
      fields: { ...payer },
    }),
  },
}));

let app: express.Express;
beforeAll(async () => {
  process.env.ORDER_VIEW_SECRET = 'test-order-view-secret';
  process.env.ORDER_STATUS_LINK_SECRET = 'x'.repeat(40);
  const router = (await import('@api/routes/payment.routes')).default;
  app = express();
  app.use('/payments', router);
});

const poll = (headers: Record<string, string>) =>
  request(app).get(`/payments/instapay/${ORDER}/receipt/${RECEIPT}`).set(headers);

describe('receipt poll: who sees the payer identity', () => {
  it('the signed order-status link gets the receipt with every payer field nulled', async () => {
    const { signOrderStatusLinkToken } = await import('@api/lib/order-status-link-token');
    const link = signOrderStatusLinkToken(STORE, ORDER);
    const res = await poll({ 'X-Order-Status-Link': link });
    expect(res.status).toBe(200);
    const r = res.body.data.receipt;
    for (const o of [r.extracted, r.fields]) {
      expect(o).toMatchObject({ amountMinor: 12_345, reference: '987654' });
      expect([o.payerName, o.payerAddress, o.payerMobile, o.payerBank]).toEqual([
        null,
        null,
        null,
        null,
      ]);
    }
    expect(JSON.stringify(res.body)).not.toMatch(/Mona|instapay|0100|CIB/);
  });

  it('the order view token gets the payer fields', async () => {
    const { signOrderViewToken } = await import('@api/lib/order-view-token');
    const res = await poll({ 'X-Order-View-Token': signOrderViewToken(ORDER) });
    expect(res.status).toBe(200);
    expect(res.body.data.receipt.fields).toMatchObject(payer);
  });

  it('no credential: masked', async () => {
    const res = await poll({});
    expect(res.status).toBe(200);
    expect(res.body.data.receipt.fields.payerName).toBeNull();
  });
});
