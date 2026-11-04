/**
 * POST /stores/:storeId/orders/admin — the coupon-override boundary
 * (owner decision 2026-09-25, #1370, ruling M-OVR-1).
 *
 * The route Zod-validates the override (a boolean, and it needs a coupon code
 * and a 3–500 char reason) and forwards the CALLER'S ROLE — from the verified
 * token, never the body — so the service can refuse it for staff. The service
 * half (403 for staff, the recorded override) is proven against a real DB in
 * tests/integration/admin-order-coupon-rules.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

let role = 'store_admin';
vi.mock('@api/middleware/auth', () => ({
  rejectImpersonated: (_req: any, _res: any, next: any) => next(),
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role };
    next();
  },
  authorize:
    (..._roles: string[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
  customerUserId: (_req: any) => undefined,
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
  checkStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature:
    (..._args: unknown[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));
vi.mock('@api/middleware/rbac', () => ({
  requirePermission:
    (..._args: unknown[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));
vi.mock('@api/middleware/security', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
  writeLimiter: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/utils/store-helpers', () => ({ getAuthUser: (req: any) => req.user }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@ebda/database', () => ({
  prisma: {},
  Prisma: { DbNull: null },
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
}));
const createAdminOrder = vi.fn();
vi.mock('@api/services/order.service', () => ({
  OrderService: { createAdminOrder: (...a: unknown[]) => createAdminOrder(...a) },
  assertValidTransition: vi.fn(),
}));
vi.mock('@api/services/invoice.service', () => ({ InvoiceService: {} }));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }));
vi.mock('@api/services/payment-providers/payment.factory', () => ({ PaymentService: {} }));
vi.mock('@api/services/payment-event.service', () => ({ recordPaymentEvent: vi.fn() }));
vi.mock('@api/services/payment-confirm.service', () => ({
  confirmPaymentFromProviderStatus: vi.fn(),
}));
vi.mock('@api/lib/payment-line-items', () => ({ buildPaymentLineItems: vi.fn() }));
vi.mock('@api/services/payment-providers/refund-settlement', () => ({
  resolveRefundSettlement: vi.fn(),
  readAccountedRefundEventIds: vi.fn(),
  appendRefundEventId: vi.fn(),
  recordRefundStatus: vi.fn(),
  REFUND_EVENT_IDS_KEY: 'refund-event-ids',
  REFUND_STATUS_BY_ID_KEY: 'refund-status-by-id',
}));
vi.mock('exceljs', () => ({ default: class {} }));
vi.mock('@api/lib/exports/xlsx', () => ({ neutralizeRowObject: vi.fn() }));
vi.mock('@api/lib/public-cache', () => ({
  invalidateCached: vi.fn(),
  invalidateCachedPrefix: vi.fn(),
  invalidateStoreProductCaches: vi.fn(),
  invalidateCustomersCache: vi.fn(),
}));

const STORE_ID = '11111111-1111-1111-1111-111111111111';
const BASE = {
  shippingAddress: { firstName: 'A', phone: '96550000000' },
  items: [{ productId: '44444444-4444-4444-4444-444444444444', quantity: 1 }],
  couponCode: 'VIP10',
};

async function app(): Promise<Express> {
  const { default: router } = await import('@api/routes/order.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  const server = express();
  server.use(express.json());
  server.use('/api/v1/stores/:storeId/orders', router);
  server.use(errorHandler);
  return server;
}

const post = async (body: Record<string, unknown>) =>
  request(await app())
    .post(`/api/v1/stores/${STORE_ID}/orders/admin`)
    .send(body);

afterEach(() => {
  vi.clearAllMocks();
  role = 'store_admin';
});

describe('admin order coupon override — route boundary (#1370)', () => {
  it('forwards a valid override with the caller role from the token', async () => {
    createAdminOrder.mockResolvedValue({ id: 'o1' });
    const res = await post({
      ...BASE,
      overrideCouponRules: true,
      couponOverrideReason: '  owner approved  ',
      // A body-supplied role is not a field — it never reaches the service.
      role: 'super_admin',
    });
    expect(res.status).toBe(200);
    const [storeId, userId, data, actor] = createAdminOrder.mock.calls[0];
    expect([storeId, userId]).toEqual([STORE_ID, 'admin-1']);
    expect(data).toMatchObject({
      overrideCouponRules: true,
      couponOverrideReason: 'owner approved',
    });
    expect(data).not.toHaveProperty('role');
    expect(actor).toEqual({ role: 'store_admin' });
  });

  it('forwards staff as staff — the service refuses the override for that role', async () => {
    role = 'staff';
    createAdminOrder.mockResolvedValue({ id: 'o1' });
    await post({ ...BASE, overrideCouponRules: true, couponOverrideReason: 'please' });
    expect(createAdminOrder.mock.calls[0][3]).toEqual({ role: 'staff' });
  });

  it.each([
    ['no reason', { overrideCouponRules: true }],
    ['a blank reason', { overrideCouponRules: true, couponOverrideReason: '   ' }],
    [
      'a reason over 500 chars',
      { overrideCouponRules: true, couponOverrideReason: 'x'.repeat(501) },
    ],
    [
      'no coupon code',
      { overrideCouponRules: true, couponOverrideReason: 'ok ok', couponCode: undefined },
    ],
    ['a non-boolean flag', { overrideCouponRules: 'yes', couponOverrideReason: 'ok ok' }],
  ])('rejects an override with %s (400) before the service', async (_label, extra) => {
    const res = await post({ ...BASE, ...extra });
    expect(res.status).toBe(400);
    expect(createAdminOrder).not.toHaveBeenCalled();
  });

  it('an order without the flag passes through unchanged (rules enforced by default)', async () => {
    createAdminOrder.mockResolvedValue({ id: 'o1' });
    const res = await post(BASE);
    expect(res.status).toBe(200);
    expect(createAdminOrder.mock.calls[0][2].overrideCouponRules).toBeUndefined();
  });
});

describe('admin order custom shipping fee — audit (BE:S-23)', () => {
  it('records who set a custom shipping fee, and nothing when none was set', async () => {
    const { auditLog } = await import('@api/middleware/security');
    createAdminOrder.mockResolvedValue({ id: 'o1', orderNumber: 'N-1' });
    const res = await post({ ...BASE, couponCode: undefined, shippingOverride: 2500 });
    expect(res.status).toBe(200);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'order.shipping_override',
        userId: 'admin-1',
        storeId: STORE_ID,
        resourceId: 'o1',
        details: { orderNumber: 'N-1', shippingOverride: 2500 },
      })
    );
    vi.mocked(auditLog).mockClear();
    await post({ ...BASE, couponCode: undefined });
    expect(auditLog).not.toHaveBeenCalled();
  });
});
