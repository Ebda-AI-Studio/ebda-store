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
vi.mock('@ebda/database', () => ({
  prisma: {
    payment: {
      findFirst: (...a: unknown[]) => paymentFindFirst(...a),
      update: (...a: unknown[]) => paymentUpdate(...a),
    },
    order: {
      update: (...a: unknown[]) => orderUpdate(...a),
      findFirst: (...a: unknown[]) => orderFindFirst(...a),
    },
    store: { findUnique: vi.fn().mockResolvedValue({ name: 'Store' }) },
  },
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
  // The error-handler middleware checks `err instanceof
  // Prisma.PrismaClientKnownRequestError` for every non-AppError/ZodError —
  // must be present or that check itself throws for a generic Error.
  Prisma: { PrismaClientKnownRequestError: class PrismaClientKnownRequestError {} },
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

const getRefundStatus = vi.fn();
const findInFlight = vi.fn().mockResolvedValue([]);
vi.mock('@api/services/payment-providers/payment.factory', () => ({
  PaymentService: { getRefundStatus: (...a: unknown[]) => getRefundStatus(...a) },
  findInFlightRefundClaimAmounts: (...a: unknown[]) => findInFlight(...a),
}));

const applyRefundEffects = vi.fn().mockResolvedValue(undefined);
const assertValidTransitionMock = vi.fn();
const recordRefundOutsideReturn = vi.fn();
vi.mock('@api/services/order.service', () => ({
  OrderService: {
    applyRefundEffects: (...a: unknown[]) => applyRefundEffects(...a),
    recordRefundOutsideReturn: (...a: unknown[]) => recordRefundOutsideReturn(...a),
  },
  assertValidTransition: (...a: unknown[]) => assertValidTransitionMock(...a),
}));

const sendAlert = vi.fn().mockResolvedValue(undefined);
vi.mock('@api/services/alerts.service', () => ({
  sendAlert: (...a: unknown[]) => sendAlert(...a),
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
    provider: 'paymob',
    status: 'completed',
    // The route reads this to decide whether the refund settles the payment.
    // Prisma returns it (the query has no `select`), so omitting it here made
    // the mock diverge from production.
    amount: 5000,
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
      where: { id: ORDER_ID, storeId: STORE_ID },
      data: { status: 'refunded', paymentStatus: 'refunded' },
    });
  });
});

describe('POST /:orderId/refresh-refund-status — partial out-of-band refunds', () => {
  beforeAll(async () => {
    app = await buildApp();
  });
  afterEach(() => {
    vi.clearAllMocks();
    orderFindFirst.mockResolvedValue({ status: 'delivered' });
    orderUpdate.mockResolvedValue({});
  });

  /**
   * `Payment.status` decides whether ReturnService will accept the payment as a
   * refund source, and `refundedAmount` is the budget the refund path
   * compare-and-swaps against. Asserting 'refunded' for a refund that only
   * covered part of the payment marks it settled while money is still
   * refundable, so every later partial return is rejected for having no
   * refundable payment.
   */
  it('records a PARTIAL out-of-band refund as partially_refunded, not refunded', async () => {
    mockPaymentNeedingSideEffects();
    getRefundStatus.mockResolvedValue({
      status: 'completed',
      refundedAmount: 2000, // 2000 of a 5000 payment
      amount: 2000,
      refundReference: 'ref-partial',
    });

    applyRefundEffects.mockResolvedValue(undefined);
    await request(app)
      .post(`/api/v1/stores/${STORE_ID}/orders/${ORDER_ID}/refresh-refund-status`)
      .send({});

    const data = (paymentUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.status).toBe('partially_refunded');
    expect(data.refundedAmount).toBe(2000);

    // ...and the whole-order effects must NOT run for a partial refund, or a
    // 2000-fil refund on a 5000-fil payment restores the entire order's
    // inventory and marks the order terminal.
    expect(applyRefundEffects).not.toHaveBeenCalled();
    expect(orderUpdate).not.toHaveBeenCalled();
  });

  /**
   * A provider status payload with NO amount is not evidence of a partial
   * refund. Falling through to 0 recorded a FULL out-of-band refund as
   * `partially_refunded` with `refundedAmount: 0`, which suppressed every
   * whole-order effect (inventory restore, coupon/loyalty/affiliate reversal,
   * GL reversal) while the money had already left the gateway — and left the
   * payment looking refundable, so a later return could fire a SECOND real
   * gateway refund. Unknown amount => FULL, same rule as the webhook path.
   */
  it('records the refund id it counted, so a later webhook cannot count it twice', async () => {
    // This route raised `refundedAmount` but wrote nothing identifying the
    // refund, so the provider webhook arriving for that SAME refund saw an
    // unknown id, treated it as a new one and added the amount again.
    mockPaymentNeedingSideEffects();
    getRefundStatus.mockResolvedValue({
      status: 'completed',
      refundId: 'rf_counted',
      refundedAmount: 2000,
      amount: 2000,
      refundReference: 'ref-partial',
    });

    applyRefundEffects.mockResolvedValue(undefined);
    await request(app)
      .post(`/api/v1/stores/${STORE_ID}/orders/${ORDER_ID}/refresh-refund-status`)
      .send({});

    const data = (paymentUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.refundedAmount).toBe(2000);
    const meta = data.metadata as Record<string, unknown>;
    expect(meta.refundEventIds, 'the ledger every adding path must maintain').toContain(
      'rf_counted'
    );
    expect(meta.refundStatusById).toMatchObject({ rf_counted: 'completed' });
  });

  it('an in-flight in-band claim of the same amount absorbs this refresh: the total is not raised twice', async () => {
    mockPaymentNeedingSideEffects();
    findInFlight.mockResolvedValueOnce([2000]);
    getRefundStatus.mockResolvedValue({
      status: 'completed',
      refundId: 'rf_inflight',
      refundedAmount: 2000,
      amount: 2000,
      refundReference: 'ref-inflight',
    });
    applyRefundEffects.mockResolvedValue(undefined);
    await request(app)
      .post(`/api/v1/stores/${STORE_ID}/orders/${ORDER_ID}/refresh-refund-status`)
      .send({});
    expect(findInFlight).toHaveBeenCalled();
    const data = (paymentUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    const meta = data.metadata as Record<string, unknown>;
    expect(meta.refundEventIds ?? []).not.toContain('rf_inflight');
  });

  it('treats an amount-less provider response as a FULL refund, not a 0-fil partial', async () => {
    mockPaymentNeedingSideEffects();
    getRefundStatus.mockResolvedValue({
      status: 'completed',
      refundReference: 'ref-no-amount',
    });

    applyRefundEffects.mockResolvedValue(undefined);
    await request(app)
      .post(`/api/v1/stores/${STORE_ID}/orders/${ORDER_ID}/refresh-refund-status`)
      .send({});

    const data = (paymentUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.status).toBe('refunded');
    expect(data.refundedAmount).toBe(5000);

    // The whole-order reversal chain must run — the money is gone.
    expect(applyRefundEffects).toHaveBeenCalledWith(STORE_ID, ORDER_ID);
    expect(orderUpdate).toHaveBeenCalledWith({
      where: { id: ORDER_ID, storeId: STORE_ID },
      data: { status: 'refunded', paymentStatus: 'refunded' },
    });
  });

  // #1432 / #1472 — a payment already recorded as partially_refunded must not
  // be locked out: when the merchant refunds the balance in the provider
  // portal, the refresh promotes it to refunded and runs the whole-order
  // reversal exactly once.
  it('promotes a partially_refunded payment when the balance is refunded later', async () => {
    paymentFindFirst.mockResolvedValue({
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      refundId: 'rf_b',
      provider: 'paymob',
      status: 'partially_refunded',
      amount: 5000,
      refundedAmount: 2000,
      metadata: {
        refundStatus: 'completed',
        refundEventIds: ['rf_a'],
        refundStatusById: { rf_a: 'completed' },
      },
    });
    getRefundStatus.mockResolvedValue({
      status: 'completed',
      refundId: 'rf_b',
      refundedAmount: 3000,
      amount: 3000,
      refundReference: 'ref-balance',
    });
    applyRefundEffects.mockResolvedValue(undefined);

    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/orders/${ORDER_ID}/refresh-refund-status`)
      .send({});

    expect(res.status).toBe(200);
    const data = (paymentUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.status).toBe('refunded');
    expect(data.refundedAmount).toBe(5000);
    expect(applyRefundEffects).toHaveBeenCalledTimes(1);
    expect(orderUpdate).toHaveBeenCalledWith({
      where: { id: ORDER_ID, storeId: STORE_ID },
      data: { status: 'refunded', paymentStatus: 'refunded' },
    });
  });

  // Owner decision 2026-10-01 (#1455): a partial refund recorded here is
  // booked as a revenue refund for the amount this refresh added. Now that a
  // partially_refunded payment re-enters this route, a refresh that adds
  // nothing must not book it again.
  it('books the partial once, not on a repeat refresh that records nothing new', async () => {
    mockPaymentNeedingSideEffects();
    getRefundStatus.mockResolvedValue({
      status: 'completed',
      refundId: 'rf_a',
      refundedAmount: 2000,
      amount: 2000,
    });
    await request(app)
      .post(`/api/v1/stores/${STORE_ID}/orders/${ORDER_ID}/refresh-refund-status`)
      .send({});
    expect(recordRefundOutsideReturn).toHaveBeenCalledTimes(1);
    expect(recordRefundOutsideReturn).toHaveBeenCalledWith(STORE_ID, ORDER_ID, {
      providerRefundId: 'rf_a',
      amount: 2000,
    });

    paymentFindFirst.mockResolvedValue({
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      refundId: 'rf_a',
      provider: 'paymob',
      status: 'partially_refunded',
      amount: 5000,
      refundedAmount: 2000,
      metadata: { refundEventIds: ['rf_a'], refundStatusById: { rf_a: 'completed' } },
    });
    await request(app)
      .post(`/api/v1/stores/${STORE_ID}/orders/${ORDER_ID}/refresh-refund-status`)
      .send({});
    expect(recordRefundOutsideReturn).toHaveBeenCalledTimes(1);
  });

  it('settles the payment but does not re-reverse an order already marked refunded', async () => {
    paymentFindFirst.mockResolvedValue({
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      refundId: 'rf_b',
      provider: 'paymob',
      status: 'partially_refunded',
      amount: 5000,
      refundedAmount: 2000,
      metadata: { refundEventIds: ['rf_a'], refundStatusById: { rf_a: 'completed' } },
    });
    getRefundStatus.mockResolvedValue({
      status: 'completed',
      refundId: 'rf_b',
      refundedAmount: 3000,
      amount: 3000,
    });
    orderFindFirst.mockResolvedValue({ status: 'refunded' });

    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/orders/${ORDER_ID}/refresh-refund-status`)
      .send({});

    expect(res.status).toBe(200);
    const data = (paymentUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.status).toBe('refunded');
    expect(applyRefundEffects).not.toHaveBeenCalled();
    expect(orderUpdate).not.toHaveBeenCalled();
  });

  it('re-entering a partially_refunded payment never re-counts an accounted refund', async () => {
    paymentFindFirst.mockResolvedValue({
      id: PAYMENT_ID,
      orderId: ORDER_ID,
      refundId: 'rf_a',
      provider: 'paymob',
      status: 'partially_refunded',
      amount: 5000,
      refundedAmount: 2000,
      metadata: { refundEventIds: ['rf_a'], refundStatusById: { rf_a: 'completed' } },
    });
    getRefundStatus.mockResolvedValue({
      status: 'completed',
      refundId: 'rf_a',
      refundedAmount: 2000,
      amount: 2000,
    });

    await request(app)
      .post(`/api/v1/stores/${STORE_ID}/orders/${ORDER_ID}/refresh-refund-status`)
      .send({});

    const data = (paymentUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.status).toBe('partially_refunded');
    expect(data.refundedAmount).toBe(2000);
    expect(applyRefundEffects).not.toHaveBeenCalled();
  });

  it('still records a FULL out-of-band refund as refunded', async () => {
    mockPaymentNeedingSideEffects();

    applyRefundEffects.mockResolvedValue(undefined);
    await request(app)
      .post(`/api/v1/stores/${STORE_ID}/orders/${ORDER_ID}/refresh-refund-status`)
      .send({});

    const data = (paymentUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.status).toBe('refunded');
    expect(data.refundedAmount).toBe(5000);
  });
});
