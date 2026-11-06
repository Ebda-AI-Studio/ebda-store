/**
 * #1360 — POST /payments/refund writes an append-only audit row whose
 * `toStatus` must agree with the Payment row PaymentService.refund just wrote.
 * The service decides "full" against the REMAINING balance; the audit used to
 * compare the slice against the ORIGINAL amount, so the final slice of a
 * piecewise refund was audited as partially_refunded on a refunded payment.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  paymentFindFirst: vi.fn(),
  paymentFindUnique: vi.fn(),
  auditLog: vi.fn(),
  sendAlert: vi.fn(),
  refund: vi.fn(),
  recordPaymentEvent: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  prisma: {
    payment: {
      findFirst: (...a: unknown[]) => h.paymentFindFirst(...a),
      findUnique: (...a: unknown[]) => h.paymentFindUnique(...a),
    },
  },
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
  withStore: (_s: string, fn: () => unknown) => fn(),
}));
// The store comes from the provider reference through a definer (strict RLS hides a contextless read).
vi.mock('@api/lib/definer', () => ({
  getOrderStoreId: vi.fn(),
  getPaymentStoreId: vi.fn(),
  resolvePaymentEventsStore: vi.fn(),
  resolveStoreFromWebhookRef: (...a: unknown[]) => h.resolve(...a),
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/auth', () => ({
  authorize: () => (_q: any, _s: any, n: any) => n(),
  rejectImpersonated: (_req: any, _res: any, next: any) => next(),
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'u1', role: 'super_admin' };
    next();
  },
  optionalAuthenticate: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/rbac', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({
  paymentLimiter: (_req: any, _res: any, next: any) => next(),
  uploadLimiter: (_req: any, _res: any, next: any) => next(),
  dailyUploadLimiter: (_req: any, _res: any, next: any) => next(),
  auditLog: (...a: unknown[]) => h.auditLog(...a),
}));
vi.mock('@api/services/alerts.service', () => ({
  sendAlert: (...a: unknown[]) => h.sendAlert(...a),
}));
vi.mock('@api/utils/store-helpers', () => ({ getAuthUser: (req: any) => req.user }));
vi.mock('@api/services/payment-providers/payment.factory', () => ({
  PaymentService: { refund: (...a: unknown[]) => h.refund(...a) },
}));
// the route appends through `recordPaymentEventForStore` (a Durable Object store's timeline is in its DO; Postgres joins the scope)
vi.mock('@api/services/payment-event.service', () => ({
  recordPaymentEvent: (...a: unknown[]) => h.recordPaymentEvent(...a),
  recordPaymentEventForStore: (...a: unknown[]) => h.recordPaymentEvent(...a),
}));
vi.mock('@api/services/order.service', () => ({ OrderService: {} }));
vi.mock('@api/config', () => ({ config: {} }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let app: Express;
beforeAll(async () => {
  const { default: router } = await import('@api/routes/payment.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/api/v1/payments', router);
  app.use(errorHandler);
});
afterEach(() => vi.clearAllMocks());
beforeEach(() => {
  h.auditLog.mockResolvedValue(undefined);
  h.sendAlert.mockResolvedValue(undefined);
  h.recordPaymentEvent.mockResolvedValue(undefined);
  h.resolve.mockResolvedValue('s1');
});

function paymentRow(refundedAmount: number) {
  return {
    id: 'pay_1',
    orderId: 'order_1',
    status: refundedAmount > 0 ? 'partially_refunded' : 'completed',
    provider: 'paymob',
    amount: 5000,
    refundedAmount,
    // the payment's store IS the resolved one (the route refuses any other)
    order: { id: 'order_1', storeId: 's1' },
  };
}

describe('POST /payments/refund — audit toStatus', () => {
  it('audits the final slice of a piecewise refund as refunded', async () => {
    h.paymentFindFirst.mockResolvedValue(paymentRow(2000));
    h.refund.mockResolvedValue({ transactionId: 'txn_1', refundId: 'rf_2', amount: 3000 });
    h.paymentFindUnique.mockResolvedValue({ status: 'refunded' });

    const res = await request(app)
      .post('/api/v1/payments/refund')
      .send({ transactionId: 'txn_1', amount: 3000 });

    expect(res.status).toBe(200);
    expect(h.recordPaymentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ fromStatus: 'partially_refunded', toStatus: 'refunded' })
    );
  });

  it('audits a first partial slice as partially_refunded (control)', async () => {
    h.paymentFindFirst.mockResolvedValue(paymentRow(0));
    h.refund.mockResolvedValue({ transactionId: 'txn_1', refundId: 'rf_1', amount: 2000 });
    h.paymentFindUnique.mockResolvedValue({ status: 'partially_refunded' });

    await request(app)
      .post('/api/v1/payments/refund')
      .send({ transactionId: 'txn_1', amount: 2000 });

    expect(h.recordPaymentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ toStatus: 'partially_refunded' })
    );
  });

  it('a failing audit write AFTER the money moved still answers 200 and raises a P1 alert (M-128)', async () => {
    h.paymentFindFirst.mockResolvedValue(paymentRow(0));
    h.refund.mockResolvedValue({ transactionId: 'txn_1', refundId: 'rf_1', amount: 2000 });
    h.paymentFindUnique.mockResolvedValue({ status: 'partially_refunded' });
    h.auditLog.mockRejectedValue(new Error('audit db down'));

    const res = await request(app)
      .post('/api/v1/payments/refund')
      .send({ transactionId: 'txn_1', amount: 2000 });

    expect(res.status).toBe(200);
    expect(res.body.data.refund.refundId).toBe('rf_1');
    expect(h.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'p1', source: 'payment.refund.audit_failed' })
    );
  });

  it('a failing REFUND still surfaces as an error and writes no audit row', async () => {
    h.paymentFindFirst.mockResolvedValue(paymentRow(0));
    h.refund.mockRejectedValue(new Error('provider down'));

    const res = await request(app)
      .post('/api/v1/payments/refund')
      .send({ transactionId: 'txn_1', amount: 2000 });

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(h.auditLog).not.toHaveBeenCalled();
    expect(h.recordPaymentEvent).not.toHaveBeenCalled();
  });
});

describe('payment lookups by provider reference stay inside the named provider (Ruling ITEST-14)', () => {
  it('refund: the optional provider reaches the store resolver', async () => {
    h.paymentFindFirst.mockResolvedValue(paymentRow(0));
    h.refund.mockResolvedValue({ transactionId: 'txn_1', refundId: 'rf_1', amount: 2000 });
    await request(app)
      .post('/api/v1/payments/refund')
      .send({ transactionId: 'txn_1', amount: 2000, provider: 'kashier' });
    expect(h.resolve).toHaveBeenCalledWith({ transactionId: 'txn_1', provider: 'kashier' });
  });

  it('refund: without a provider the lookup is unchanged', async () => {
    h.paymentFindFirst.mockResolvedValue(paymentRow(0));
    h.refund.mockResolvedValue({ transactionId: 'txn_1', refundId: 'rf_1', amount: 2000 });
    await request(app)
      .post('/api/v1/payments/refund')
      .send({ transactionId: 'txn_1', amount: 2000 });
    expect(h.resolve).toHaveBeenCalledWith({ transactionId: 'txn_1', provider: undefined });
  });

  it('refund: an unknown provider name is refused before any lookup', async () => {
    const res = await request(app)
      .post('/api/v1/payments/refund')
      .send({ transactionId: 'txn_1', amount: 2000, provider: 'tap' });
    expect(res.status).toBe(400);
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it('status: the ?provider= query narrows the store lookup', async () => {
    h.resolve.mockResolvedValue(null); // 404 right after the lookup; only the call matters here
    const res = await request(app).get('/api/v1/payments/status/txn_9?provider=fawry');
    expect(res.status).toBe(404);
    expect(h.resolve).toHaveBeenCalledWith({ transactionId: 'txn_9', provider: 'fawry' });
  });
});
