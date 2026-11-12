/**
 * GET /payments/status/:tx narrows the store lookup by the optional ?provider= (Ruling ITEST-14).
 * (The POST /payments/refund cases that lived here went with the route, ruling F9-REUSE-1.)
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
  auditLogStrict: (...a: unknown[]) => h.auditLog(...a),
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

describe('payment lookups by provider reference stay inside the named provider (Ruling ITEST-14)', () => {
  it('status: the ?provider= query narrows the store lookup', async () => {
    h.resolve.mockResolvedValue(null); // 404 right after the lookup; only the call matters here
    const res = await request(app).get('/api/v1/payments/status/txn_9?provider=fawry');
    expect(res.status).toBe(404);
    expect(h.resolve).toHaveBeenCalledWith({ transactionId: 'txn_9', provider: 'fawry' });
  });
});
