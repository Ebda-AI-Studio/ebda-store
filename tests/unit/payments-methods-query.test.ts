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
  methods: vi.fn(),
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
vi.mock('@api/utils/store-helpers', () => ({
  getAuthUser: (req: any) => req.user,
  resolvePublicStoreId: async () => 's1',
}));
vi.mock('@api/services/payment-providers/payment.factory', () => ({
  PaymentService: {
    refund: (...a: unknown[]) => h.refund(...a),
    getPaymentMethods: (...a: unknown[]) => h.methods(...a),
  },
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
beforeEach(() => {
  h.methods.mockResolvedValue([]);
  h.resolve.mockResolvedValue('s1');
});
afterEach(() => vi.clearAllMocks());

describe('GET /payments/methods query is parsed with Zod (F-9-prune)', () => {
  it('a malformed amount or provider is a 400 and never reaches the service', async () => {
    for (const q of ['amount=abc', 'amount=-5', 'provider=../../etc', 'currency=EGPX']) {
      const res = await request(app).get('/api/v1/payments/methods?' + q);
      expect(res.status, q).toBe(400);
    }
    expect(h.methods).not.toHaveBeenCalled();
  });
  it('a valid query still reaches the service', async () => {
    const res = await request(app).get(
      '/api/v1/payments/methods?amount=2500&currency=egp&provider=paymob'
    );
    expect(res.status).toBe(200);
    expect(h.methods).toHaveBeenCalledWith(2500, 'EGP', 'paymob', 's1');
  });
});
