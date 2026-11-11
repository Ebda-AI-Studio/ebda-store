/**
 * Route-level tests for POST /:orderId/refund-via-provider (money-integrity
 * Task 5). Boots a minimal Express app mounting only order.routes with every
 * auth/db/provider dependency mocked, then drives the route via supertest —
 * using the same minimal app-bootstrap pattern as the other route tests.
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
vi.mock('@ebda/database', () => ({
  prisma: {
    order: { findFirst: (...a: unknown[]) => orderFindFirst(...a) },
  },
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
}));

vi.mock('@api/middleware/auth', () => ({
  rejectImpersonated: (_req: any, _res: any, next: any) => next(),
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

// the AuthState-backed SET NX client withIdempotencyKey uses (#628), as an in-memory double
const kv = new Map<string, string>();
vi.mock('@api/services/redis.service', () => ({
  redis: {
    isAvailable: () => true,
    getClient: () => ({
      set: async (k: string, v: string, ...rest: unknown[]) => {
        if (rest.includes('NX') && kv.has(k)) return null;
        kv.set(k, v);
        return 'OK';
      },
      get: async (k: string) => kv.get(k) ?? null,
      del: async (k: string) => (kv.delete(k) ? 1 : 0),
    }),
  },
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
    payments: [{ transactionId: 'txn_1', provider: 'paymob' }],
  });
}

describe('POST /:orderId/refund-via-provider', () => {
  beforeAll(async () => {
    app = await buildApp();
  });

  afterEach(() => {
    vi.clearAllMocks();
    kv.clear();
  });

  it('returns non-2xx (via next(err)) when PaymentService.refund fails — not swallowed to 200', async () => {
    mockOrderWithCompletedPayment();
    paymentServiceRefund.mockRejectedValue(new Error('gateway timeout'));

    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/orders/${ORDER_ID}/refund-via-provider`)
      .set('Idempotency-Key', `key-${Math.random().toString(36).slice(2, 12)}`)
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
      provider: 'paymob',
      status: 'completed',
    });

    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/orders/${ORDER_ID}/refund-via-provider`)
      .set('Idempotency-Key', `key-${Math.random().toString(36).slice(2, 12)}`)
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
      provider: 'paymob',
      status: 'completed',
    });

    await request(app)
      .post(`/api/v1/stores/${STORE_ID}/orders/${ORDER_ID}/refund-via-provider`)
      .set('Idempotency-Key', `key-${Math.random().toString(36).slice(2, 12)}`)
      .send({});

    const where = orderFindFirst.mock.calls[0][0].include.payments.where;
    expect(where.status).toEqual({ in: ['completed', 'partially_refunded'] });
  });

  // #628: no key = no refund (a keyless retry after a timeout is the double refund)
  it('refuses a request without an Idempotency-Key with 400 and never calls the provider', async () => {
    mockOrderWithCompletedPayment();
    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/orders/${ORDER_ID}/refund-via-provider`)
      .send({ amount: 30000 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(paymentServiceRefund).not.toHaveBeenCalled();
  });

  it('same key: the first answer comes back and the provider is called once; the key reaches the DO as attemptKey', async () => {
    mockOrderWithCompletedPayment();
    paymentServiceRefund.mockResolvedValue({
      refundId: 'rf_9',
      amount: 30000,
      provider: 'kashier',
      status: 'completed',
    });
    const send = () =>
      request(app)
        .post(`/api/v1/stores/${STORE_ID}/orders/${ORDER_ID}/refund-via-provider`)
        .set('Idempotency-Key', 'dialog-key-0001')
        .send({ amount: 30000 });
    const a = await send();
    const b = await send();
    expect(a.status).toBe(200);
    expect(b.body.data.refundId).toBe('rf_9');
    expect(paymentServiceRefund).toHaveBeenCalledTimes(1);
    expect(paymentServiceRefund.mock.calls[0][0].attemptKey).toMatch(/^refund-via-provider:/);
  });

  it('a retry after an indeterminate failure (money may have moved) is refused 409, never a second refund', async () => {
    mockOrderWithCompletedPayment();
    const { markRefundMayHaveExecuted } =
      await import('@api/services/payment-providers/refund-outcome');
    const { AppError } = await import('@api/middleware/error-handler');
    paymentServiceRefund.mockRejectedValue(
      markRefundMayHaveExecuted(
        new AppError(502, 'PROVIDER_REFUND_INDETERMINATE', 'the provider did not confirm')
      )
    );
    const send = () =>
      request(app)
        .post(`/api/v1/stores/${STORE_ID}/orders/${ORDER_ID}/refund-via-provider`)
        .set('Idempotency-Key', 'dialog-key-0002')
        .send({ amount: 30000 });
    const a = await send();
    expect(a.status).toBe(502);
    expect(a.body.error.code).toBe('PROVIDER_REFUND_INDETERMINATE');
    const b = await send();
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(paymentServiceRefund).toHaveBeenCalledTimes(1);
  });
});
