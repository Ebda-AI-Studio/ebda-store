/**
 * Order refund routes — missing-permission regression guard.
 *
 * apps/api/src/routes/order.routes.ts POST /:orderId/refund-via-provider
 * and POST /:orderId/refresh-refund-status only required
 * authorize('store_admin','super_admin','staff') — any `staff` teammate
 * could trigger a real provider refund or flip Payment.status, despite
 * `staff` intentionally NOT having the 'orders:refund' permission
 * everywhere else (payment.routes.ts POST /refund already gates on it).
 * Fix: both routes now also require `requirePermission('orders:refund')`,
 * which `rolePermissions` in middleware/rbac.ts grants only to
 * store_admin/super_admin.
 *
 * This test exercises the real `requirePermission` middleware (not
 * mocked) directly, and mounts the real order router to prove the guard is
 * actually wired into both routes: a staff request is refused with 403 and the
 * handler never touches the store DB; a store_admin request reaches the handler.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { requirePermission } from '../../apps/api/src/middleware/rbac';

// ─── Mocks for mounting the real order router (rbac stays REAL) ───────────
const state = vi.hoisted(() => ({ role: 'staff' as string }));
const storeDbSpy = vi.hoisted(() => vi.fn());
const recordRefundSpy = vi.hoisted(() => vi.fn());

vi.mock('@ebda/database', () => ({
  prisma: { $queryRaw: async () => [] },
  hasTenantContext: () => true,
  currentTenantGucs: () => undefined,
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
  Prisma: { PrismaClientKnownRequestError: class PrismaClientKnownRequestError {} },
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: (...a: unknown[]) => {
    storeDbSpy(...a);
    throw new Error('handler reached');
  },
}));
vi.mock('@api/middleware/auth', () => ({
  rejectImpersonated: (_q: any, _s: any, n: any) => n(),
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', role: state.role };
    next();
  },
  authorize: () => (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_q: any, _s: any, n: any) => n(),
  checkStoreAccess: (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: () => (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/security', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
  writeLimiter: (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/utils/store-helpers', () => ({ getAuthUser: (req: any) => req.user }));
vi.mock('@api/services/order.service', () => ({
  OrderService: {},
  assertValidTransition: vi.fn(),
}));
vi.mock('@api/services/instapay.service', () => ({
  InstapayService: { recordRefund: (...a: unknown[]) => recordRefundSpy(...a) },
}));
vi.mock('@api/services/payment-providers/payment.factory', () => ({ PaymentService: {} }));
vi.mock('@api/services/alerts.service', () => ({ sendAlert: vi.fn() }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }));
vi.mock('@api/services/payment-event.service', () => ({ recordPaymentEvent: vi.fn() }));
vi.mock('@api/services/payment-confirm.service', () => ({
  confirmPaymentFromProviderStatus: vi.fn(),
}));
vi.mock('@api/services/invoice.service', () => ({ InvoiceService: {} }));
vi.mock('@api/config', () => ({ config: {} }));
vi.mock('exceljs', () => ({ default: class {} }));
vi.mock('@api/lib/exports/xlsx', () => ({ neutralizeRowObject: vi.fn() }));

function mockReqRes(role: string) {
  const req = { user: { userId: 'user-1', role } };
  const jsonMock = vi.fn();
  const statusMock = vi.fn(() => ({ json: jsonMock }));
  const res = { status: statusMock, json: jsonMock };
  const next = vi.fn();
  return { req, res, statusMock, jsonMock, next };
}

describe('requirePermission(orders:refund) — role gating', () => {
  beforeEach(() => vi.clearAllMocks());

  it('blocks staff with 403 FORBIDDEN', () => {
    const { req, res, statusMock, jsonMock, next } = mockReqRes('staff');
    requirePermission('orders:refund')(req as any, res as any, next);
    expect(statusMock).toHaveBeenCalledWith(403);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'FORBIDDEN' }),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('allows store_admin through (legitimate same-tenant path, control)', () => {
    const { req, res, next } = mockReqRes('store_admin');
    requirePermission('orders:refund')(req as any, res as any, next);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('allows super_admin through (control)', () => {
    const { req, res, next } = mockReqRes('super_admin');
    requirePermission('orders:refund')(req as any, res as any, next);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('order.routes.ts — refund routes wire the permission guard (behaviour)', () => {
  let app: Express;
  const STORE_ID = '11111111-1111-1111-1111-111111111111';
  const ORDER_ID = '22222222-2222-2222-2222-222222222222';

  beforeAll(async () => {
    const { default: orderRouter } = await import('@api/routes/order.routes');
    const { errorHandler } = await import('@api/middleware/error-handler');
    app = express();
    app.use(express.json());
    app.use('/api/v1/stores/:storeId/orders', orderRouter);
    app.use(errorHandler);
  });

  beforeEach(() => vi.clearAllMocks());

  const post = (suffix: string) =>
    request(app).post(`/api/v1/stores/${STORE_ID}/orders/${ORDER_ID}/${suffix}`).send({});

  // Every order route that moves refund money; the guard must refuse staff on each (instapay-refund and
  // refund-match-claim were guarded too but no test asked).
  for (const suffix of ['instapay-refund', 'refund-match-claim']) {
    it(`${suffix}: staff gets 403 FORBIDDEN and the handler never touches the store DB`, async () => {
      state.role = 'staff';
      const res = await post(suffix);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(storeDbSpy).not.toHaveBeenCalled();
    });
  }

  for (const suffix of ['refund-via-provider', 'refresh-refund-status']) {
    it(`${suffix}: staff gets 403 FORBIDDEN and the handler never touches the store DB`, async () => {
      state.role = 'staff';
      const res = await post(suffix);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(storeDbSpy).not.toHaveBeenCalled();
    });

    it(`${suffix}: store_admin passes the guard and reaches the handler (control)`, async () => {
      state.role = 'store_admin';
      await post(suffix);
      expect(storeDbSpy).toHaveBeenCalledTimes(1);
    });
  }
});
