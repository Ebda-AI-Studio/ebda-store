/**
 * Route-level tests for POST /:orderId/refresh-refund-status (money-integrity
 * Task 6 fix-the-class carry-forward). This route had the IDENTICAL
 * swallow-around-`applyRefundEffects` pattern Task 5 fixed on
 * `refund-via-provider` (see tests/unit/order-refund-route.test.ts): both
 * `OrderService.applyRefundEffects` and the order-status write were wrapped
 * in a `.catch(logger.error)` that let the route fall through to its normal
 * 200 response even when the reversal chain (or the status flip) failed.
 *
 * Contract under test: a failure in either call must reach the client as a
 * non-2xx via `next(err)`, never a swallowed HTTP 200. A genuinely
 * successful refresh still returns 200.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// ─── Mocks (declared before the route module is dynamically imported) ─────

const paymentFindFirst = vi.fn();
const paymentUpdate = vi.fn().mockResolvedValue({});
const orderUpdate = vi.fn().mockResolvedValue({});
const orderFindFirst = vi.fn().mockResolvedValue({ status: 'delivered' });
vi.mock('@force/database', () => ({
  prisma: {
    payment: {
      findFirst: (...a: unknown[]) => paymentFindFirst(...a),
      update: (...a: unknown[]) => paymentUpdate(...a),
    },
    order: {
      update: (...a: unknown[]) => orderUpdate(...a),
      findFirst: (...a: unknown[]) => orderFindFirst(...a),
    },
  },
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
  // The error-handler middleware checks `err instanceof
  // Prisma.PrismaClientKnownRequestError` for every non-AppError/ZodError —
  // must be present or that check itself throws for a generic Error.
  Prisma: { PrismaClientKnownRequestError: class PrismaClientKnownRequestError {} },
}));

vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: 'store_admin' };
    next();
  },
  authorize:
    (..._roles: string[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
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

const auditLog = vi.fn().mockResolvedValue(undefined);
vi.mock('@api/middleware/security', () => ({
  auditLog: (...a: unknown[]) => auditLog(...a),
  writeLimiter: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@api/utils/store-helpers', () => ({
  getAuthUser: (req: any) => req.user,
}));

const getRefundStatus = vi.fn();
vi.mock('@api/services/payment-providers/payment.factory', () => ({
  PaymentService: { getRefundStatus: (...a: unknown[]) => getRefundStatus(...a) },
}));

const applyRefundEffects = vi.fn().mockResolvedValue(undefined);
const assertValidTransitionMock = vi.fn();
vi.mock('@api/services/order.service', () => ({
  OrderService: { applyRefundEffects: (...a: unknown[]) => applyRefundEffects(...a) },
  assertValidTransition: (...a: unknown[]) => assertValidTransitionMock(...a),
}));

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

// ─── App bootstrap ──────────────────────────────────────────────────────────

let app: Express;

async function buildApp(): Promise<Express> {
  const { default: orderRouter } = await import('@api/routes/order.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  const server = express();
  server.use(express.json());
  server.use('/api/v1/stores/:storeId/orders', orderRouter);
  server.use(errorHandler);
  return server;
}

const STORE_ID = '11111111-1111-1111-1111-111111111111';
const ORDER_ID = '22222222-2222-2222-2222-222222222222';
const PAYMENT_ID = '33333333-3333-3333-3333-333333333333';

function mockPaymentNeedingSideEffects() {
  paymentFindFirst.mockResolvedValue({
    id: PAYMENT_ID,
    orderId: ORDER_ID,
    refundId: 'rf_123',
    provider: 'myfatoorah',
    status: 'completed',
    metadata: {},
  });
  getRefundStatus.mockResolvedValue({
    status: 'completed',
    refundedAmount: 5000,
    amount: 5000,
    refundReference: 'ref-1',
  });
}

describe('POST /:orderId/refresh-refund-status', () => {
  beforeAll(async () => {
    app = await buildApp();
  });

  afterEach(() => {
    vi.clearAllMocks();
    orderFindFirst.mockResolvedValue({ status: 'delivered' });
    orderUpdate.mockResolvedValue({});
  });

  it('guards the Order.status write with assertValidTransition — a terminal order rejects and NOTHING runs (audit P2)', async () => {
    mockPaymentNeedingSideEffects();
    orderFindFirst.mockResolvedValue({ status: 'cancelled' });
    assertValidTransitionMock.mockImplementationOnce(() => {
      throw new Error('Cannot transition from cancelled to refunded');
    });

    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/orders/${ORDER_ID}/refresh-refund-status`)
      .send({});

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(assertValidTransitionMock).toHaveBeenCalledWith('cancelled', 'refunded');
    // Neither the reversal dispatch nor the status write may run after a
    // rejected transition.
    expect(applyRefundEffects).not.toHaveBeenCalled();
    expect(orderUpdate).not.toHaveBeenCalled();
  });

  it('returns non-2xx (via next(err)) when applyRefundEffects fails — not swallowed to 200', async () => {
    mockPaymentNeedingSideEffects();
    applyRefundEffects.mockRejectedValue(new Error('inngest.send failed: ECONNREFUSED'));

    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/orders/${ORDER_ID}/refresh-refund-status`)
      .send({});

    expect(res.status).not.toBe(200);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.success).toBe(false);
  });

  it('returns non-2xx (via next(err)) when the order status write fails — not swallowed to 200', async () => {
    mockPaymentNeedingSideEffects();
    applyRefundEffects.mockResolvedValue(undefined);
    orderUpdate.mockRejectedValue(new Error('connection reset'));

    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/orders/${ORDER_ID}/refresh-refund-status`)
      .send({});

    expect(res.status).not.toBe(200);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 200 on a genuinely successful refresh', async () => {
    mockPaymentNeedingSideEffects();
    applyRefundEffects.mockResolvedValue(undefined);
    orderUpdate.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/orders/${ORDER_ID}/refresh-refund-status`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(applyRefundEffects).toHaveBeenCalledWith(STORE_ID, ORDER_ID);
    expect(orderUpdate).toHaveBeenCalledWith({
      where: { id: ORDER_ID },
      data: { status: 'refunded', paymentStatus: 'refunded' },
    });
  });
});
