/**
 * Ruling SUSPEND-REFUND-1 on POST /payments/refund: a billing-suspended store's merchant may refund a customer; a
 * platform-suspended store refuses the merchant (403) and a super admin refunds on its behalf only with a written reason,
 * audited as payment.refund_requested_for_suspended_store.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  user: { userId: 'u1', role: 'store_admin' },
  store: { status: 'suspended', billingSuspendedReason: 'unpaid' as string | null },
  paymentFindFirst: vi.fn(),
  paymentFindUnique: vi.fn(),
  auditLog: vi.fn(),
  refund: vi.fn(),
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
vi.mock('@api/lib/definer', () => ({
  getOrderStoreId: vi.fn(),
  getPaymentStoreId: vi.fn(),
  resolvePaymentEventsStore: vi.fn(),
  resolveStoreFromWebhookRef: async () => 's1',
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/auth', () => ({
  authorize: () => (_q: any, _s: any, n: any) => n(),
  rejectImpersonated: (_req: any, _res: any, next: any) => next(),
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { ...h.user };
    next();
  },
  optionalAuthenticate: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/rbac', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));
// the REAL suspension rule, over a mocked store row
vi.mock('@api/middleware/store-access', async importOriginal => {
  const real = await importOriginal<typeof import('@api/middleware/store-access')>();
  return {
    ...real,
    checkStoreAccess: async (
      _s: string,
      user: { role: string },
      opts?: { write?: boolean; moneyBack?: boolean }
    ) => {
      const store = { id: 's1', ownerId: 'u1', ...h.store };
      if (opts?.write) {
        const b = real.suspendedWriteBlock(
          store,
          user.role,
          'POST',
          '/',
          undefined,
          opts.moneyBack
        );
        if (b) return { ok: false, status: 403, code: b.code, message: b.message };
      }
      return { ok: true, store };
    },
  };
});
vi.mock('@api/middleware/security', () => ({
  paymentLimiter: (_req: any, _res: any, next: any) => next(),
  uploadLimiter: (_req: any, _res: any, next: any) => next(),
  dailyUploadLimiter: (_req: any, _res: any, next: any) => next(),
  auditLog: (...a: unknown[]) => h.auditLog(...a),
  auditLogStrict: (...a: unknown[]) => h.auditLog(...a),
}));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn() }));
vi.mock('@api/utils/store-helpers', () => ({ getAuthUser: (req: any) => req.user }));
vi.mock('@api/services/payment-providers/payment.factory', () => ({
  PaymentService: { refund: (...a: unknown[]) => h.refund(...a) },
}));
vi.mock('@api/services/payment-event.service', () => ({
  recordPaymentEvent: vi.fn(),
  recordPaymentEventForStore: vi.fn(),
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
  h.paymentFindFirst.mockResolvedValue({
    id: 'pay_1',
    orderId: 'order_1',
    status: 'completed',
    provider: 'paymob',
    amount: 5000,
    refundedAmount: 0,
    order: { id: 'order_1', storeId: 's1' },
  });
  h.refund.mockResolvedValue({ transactionId: 'txn_1', refundId: 'rf_1', amount: 5000 });
  h.paymentFindUnique.mockResolvedValue({ status: 'refunded' });
});
const refund = (body: Record<string, unknown> = {}) =>
  request(app)
    .post('/api/v1/payments/refund')
    .send({ transactionId: 'txn_1', ...body });

describe('SUSPEND-REFUND-1 on POST /payments/refund', () => {
  it('billing-suspended store: the merchant refunds the customer', async () => {
    h.user = { userId: 'u1', role: 'store_admin' };
    h.store = { status: 'suspended', billingSuspendedReason: 'unpaid' };
    const res = await refund();
    expect(res.status).toBe(200);
    expect(h.refund).toHaveBeenCalledTimes(1);
  });
  it('platform-suspended store: the merchant is refused 403 and no money moves', async () => {
    h.user = { userId: 'u1', role: 'store_admin' };
    h.store = { status: 'suspended', billingSuspendedReason: null };
    const res = await refund();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('STORE_SUSPENDED');
    expect(h.refund).not.toHaveBeenCalled();
  });
  it('platform-suspended store: a super admin refunds on its behalf with a reason, audited as such', async () => {
    h.user = { userId: 'admin', role: 'super_admin' };
    h.store = { status: 'suspended', billingSuspendedReason: null };
    const res = await refund({ reason: 'store frozen for fraud review, customer paid twice' });
    expect(res.status).toBe(200);
    expect(h.refund).toHaveBeenCalledTimes(1);
    expect(h.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'payment.refund_requested_for_suspended_store',
        details: expect.objectContaining({ onBehalfOfSuspendedStore: true }),
      })
    );
  });
  it('a super admin refunding for a suspended store without a reason is refused 400 and no money moves', async () => {
    h.user = { userId: 'admin', role: 'super_admin' };
    h.store = { status: 'suspended', billingSuspendedReason: null };
    const res = await refund();
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('REASON_REQUIRED');
    expect(h.refund).not.toHaveBeenCalled();
  });
});
