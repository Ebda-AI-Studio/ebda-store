/**
 * Route-level tests for POST /:orderId/refund-via-provider (money-integrity
 * Task 5). Boots a minimal Express app mounting only order.routes with every
 * auth/db/provider dependency mocked, then drives the route via supertest —
 * matching the app-bootstrap pattern in tests/unit/contract-wbs-bridge.test.ts.
 *
 * Contract under test: any failure surfacing out of `PaymentService.refund`
 * (whatever the internal cause — provider call, DB flip, or the
 * `applyRefundEffects` fanout covered by the sibling
 * payment-service-refund.test.ts) must reach the client as a non-2xx via
 * `next(err)`, never a swallowed HTTP 200. A genuinely successful refund
 * still returns 200.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// ─── Mocks (declared before the route module is dynamically imported) ─────

const orderFindFirst = vi.fn();
vi.mock('@force/database', () => ({
  prisma: {
    order: { findFirst: (...a: unknown[]) => orderFindFirst(...a) },
  },
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
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

const paymentServiceRefund = vi.fn();
vi.mock('@api/services/payment-providers/payment.factory', () => ({
  PaymentService: { refund: (...a: unknown[]) => paymentServiceRefund(...a) },
}));

vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }));
vi.mock('@api/services/payment-event.service', () => ({ recordPaymentEvent: vi.fn() }));
vi.mock('@api/services/payment-confirm.service', () => ({
  confirmPaymentFromProviderStatus: vi.fn(),
}));
vi.mock('@api/services/order.service', () => ({ OrderService: {} }));
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

function mockOrderWithCompletedPayment() {
  orderFindFirst.mockResolvedValue({
    id: ORDER_ID,
    storeId: STORE_ID,
    orderNumber: 'ORD-1001',
    paymentStatus: 'paid',
    payments: [{ transactionId: 'txn_1', provider: 'myfatoorah' }],
  });
}

describe('POST /:orderId/refund-via-provider', () => {
  beforeAll(async () => {
    app = await buildApp();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns non-2xx (via next(err)) when PaymentService.refund fails — not swallowed to 200', async () => {
    mockOrderWithCompletedPayment();
    paymentServiceRefund.mockRejectedValue(new Error('gateway timeout'));

    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/orders/${ORDER_ID}/refund-via-provider`)
      .send({});

    expect(res.status).not.toBe(200);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 200 on a genuinely successful refund', async () => {
    mockOrderWithCompletedPayment();
    paymentServiceRefund.mockResolvedValue({
      refundId: 'rf_123',
      amount: 5000,
      provider: 'myfatoorah',
      status: 'completed',
    });

    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/orders/${ORDER_ID}/refund-via-provider`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.refundId).toBe('rf_123');
    expect(auditLog).toHaveBeenCalledTimes(1);
  });

  // #1360 — a partially refunded payment still has a refundable balance; the
  // lookup must find it or the button is dead after the first partial return.
  it('looks up a partially_refunded payment as a refund source', async () => {
    mockOrderWithCompletedPayment();
    paymentServiceRefund.mockResolvedValue({
      refundId: 'rf_2',
      amount: 3000,
      provider: 'myfatoorah',
      status: 'completed',
    });

    await request(app)
      .post(`/api/v1/stores/${STORE_ID}/orders/${ORDER_ID}/refund-via-provider`)
      .send({});

    const where = orderFindFirst.mock.calls[0][0].include.payments.where;
    expect(where.status).toEqual({ in: ['completed', 'partially_refunded'] });
  });
});
