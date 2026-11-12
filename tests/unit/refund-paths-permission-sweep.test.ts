/**
 * Refund-path permission sweep (S8, 2026-10-14).
 *
 * `staff` holds `orders:manage` and `returns:write` but deliberately NOT
 * `orders:refund` (rbac.ts). Every route that moves refund money, or records
 * that it moved, must therefore be gated on `orders:refund`. Existing tests pin
 * refund-via-provider / refresh-refund-status (order-refund-permission.test.ts)
 * and the return-complete gateway methods (return-complete-gateway-permission
 * .test.ts). This test closes the rest and adds a SWEEP: any route whose path
 * names a refund must carry the permission, so a new refund route fails here
 * instead of silently shipping open to staff.
 *
 * The route-declaration sweep is a static source check (no DB, no app boot); the
 * in-handler checks at the bottom mount the real routers with fake collaborators
 * and observe refusals and writes.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { hasPermission } from '../../apps/api/src/middleware/rbac';

// ─── Fakes for mounting the real order + return routers (rbac stays REAL) ──
const h = vi.hoisted(() => ({
  state: { role: 'staff' as string },
  getById: vi.fn(),
  updateStatus: vi.fn(),
  recordManualRefund: vi.fn(),
  complete: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  prisma: { $queryRaw: async () => [] },
  hasTenantContext: () => true,
  currentTenantGucs: () => undefined,
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
  Prisma: { PrismaClientKnownRequestError: class PrismaClientKnownRequestError {} },
}));
vi.mock('@api/middleware/auth', () => ({
  rejectImpersonated: (_q: any, _s: any, n: any) => n(),
  customerUserId: () => null,
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', role: h.state.role };
    next();
  },
  authorize: () => (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_q: any, _s: any, n: any) => n(),
  checkStoreAccess: vi.fn().mockResolvedValue(true),
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
  OrderService: {
    getById: (...a: unknown[]) => h.getById(...a),
    updateStatus: (...a: unknown[]) => h.updateStatus(...a),
    recordManualRefund: (...a: unknown[]) => h.recordManualRefund(...a),
  },
  assertValidTransition: vi.fn(),
}));
vi.mock('@api/services/return.service', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ReturnService: { complete: (...a: unknown[]) => h.complete(...a) } };
});
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

const routesDir = path.resolve(__dirname, '../../apps/api/src/routes');
const read = (f: string) => readFileSync(path.join(routesDir, f), 'utf-8');

describe('rbac: who may refund', () => {
  it('staff cannot refund; store_admin and super_admin can', () => {
    expect(hasPermission('staff', 'orders:refund')).toBe(false);
    expect(hasPermission('staff', 'payments:refund')).toBe(false);
    expect(hasPermission('customer', 'orders:refund')).toBe(false);
    expect(hasPermission('store_admin', 'orders:refund')).toBe(true);
    expect(hasPermission('super_admin', 'orders:refund')).toBe(true);
  });
});

describe('every route whose path names a refund is permission-gated', () => {
  // Platform billing refunds (Ebda refunding a merchant) are super_admin-only
  // routes in admin.routes.ts, a different surface from a store's order refunds.
  const platformBilling = new Set(['admin.routes.ts']);
  const files = readdirSync(routesDir).filter(f => f.endsWith('.routes.ts'));
  const routeDecl = /router\.(?:post|put|patch|delete)\(\s*'([^']*refund[^']*)'/gi;

  for (const file of files) {
    const src = read(file);
    for (const m of src.matchAll(routeDecl)) {
      const chain = src.slice(m.index!, m.index! + 700);
      it(`${file} ${m[1]} requires orders:refund`, () => {
        if (platformBilling.has(file)) {
          expect(chain).toMatch(/super_admin|requireRole|authorize/);
        } else {
          expect(chain).toContain("requirePermission('orders:refund')");
        }
      });
    }
  }

  it('found the refund routes this sweep is meant to cover', () => {
    const all = files.flatMap(f => [...read(f).matchAll(routeDecl)].map(m => `${f}:${m[1]}`));
    expect(all).toEqual(
      expect.arrayContaining([
        'order.routes.ts:/:orderId/instapay-refund',
        'order.routes.ts:/:orderId/refresh-refund-status',
        'order.routes.ts:/:orderId/refund-via-provider',
      ])
    );
  });
});

describe('refund-by-status and return completion check the permission in-handler', () => {
  let app: Express;
  const STORE = '11111111-1111-1111-1111-111111111111';
  const ORDER = '22222222-2222-2222-2222-222222222222';

  beforeAll(async () => {
    const { default: orderRouter } = await import('@api/routes/order.routes');
    const { default: returnRouter } = await import('@api/routes/return.routes');
    const { errorHandler } = await import('@api/middleware/error-handler');
    app = express();
    app.use(express.json());
    app.use('/stores/:storeId/orders', orderRouter);
    app.use('/stores/:storeId/returns', returnRouter);
    app.use(errorHandler);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    h.getById.mockResolvedValue({
      id: ORDER,
      status: 'delivered',
      paymentStatus: 'paid',
      payments: [{ status: 'completed', refundedAmount: 1000 }],
    });
    h.updateStatus.mockResolvedValue({ id: ORDER, status: 'refunded' });
    h.complete.mockResolvedValue({ id: 'ret-1', status: 'completed' });
  });

  const putStatus = (status: string) =>
    request(app).put(`/stores/${STORE}/orders/${ORDER}/status`).send({ status });

  it("PUT /:id/status → 'refunded' needs orders:refund before it records anything", async () => {
    h.state.role = 'staff';
    const res = await putStatus('refunded');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(h.updateStatus).not.toHaveBeenCalled();
    expect(h.recordManualRefund).not.toHaveBeenCalled();
  });

  it('PUT /:id/status: staff keep the ordinary workflow, store_admin can record the refund (controls)', async () => {
    h.state.role = 'staff';
    const shipped = await putStatus('shipped');
    expect(shipped.status).toBe(200);
    expect(h.updateStatus).toHaveBeenCalledWith(STORE, ORDER, 'shipped');

    h.updateStatus.mockClear();
    h.state.role = 'store_admin';
    const refunded = await putStatus('refunded');
    expect(refunded.status).toBe(200);
    expect(h.updateStatus).toHaveBeenCalledWith(STORE, ORDER, 'refunded');
  });

  const complete = (refundMethod: string) =>
    request(app).post(`/stores/${STORE}/returns/admin/ret-1/complete`).send({ refundMethod });

  it('return completion gates every gateway refund method on orders:refund', async () => {
    h.state.role = 'staff';
    const { GATEWAY_REFUND_METHODS } = await import('@api/services/return.service');
    expect(GATEWAY_REFUND_METHODS.length).toBeGreaterThan(0);
    for (const method of GATEWAY_REFUND_METHODS) {
      const res = await complete(method);
      expect(res.status, method).toBe(403);
      expect(res.body.error.code).toBe('REFUND_PERMISSION_REQUIRED');
    }
    expect(h.complete).not.toHaveBeenCalled();

    // control: a store_admin completes the same gateway method.
    h.state.role = 'store_admin';
    const ok = await complete(GATEWAY_REFUND_METHODS[0]);
    expect(ok.status).toBe(200);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });
});
