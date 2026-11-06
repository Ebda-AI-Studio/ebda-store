/**
 * issue 2306 — POST /payments/create disarms its compensating rollback only
 * AFTER the tenant wrap COMMITs. It used to clear `rollbackContext` INSIDE
 * the callback, so a COMMIT failure/timeout after the provider accepted (or
 * after the COD row was written) reached the outer catch disarmed: a pending
 * order with stock decremented, the cart cleared and no Payment row.
 *
 * `runInTenantContext` is stubbed to run the callback and then FAIL, which is
 * exactly a COMMIT failure: the callback's work "happened", the wrap threw.
 * Mutation-proof: moving `rollbackContext = null` back inside the callback
 * (either branch) reddens the matching case.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  commitFails: false,
  rollbackCalls: [] as unknown[][],
  orderFindFirst: vi.fn(),
  paymentFindFirst: vi.fn(),
  paymentCreate: vi.fn(),
  paymentConfigFindFirst: vi.fn(),
  createPayment: vi.fn(),
  orphanAlert: vi.fn(),
}));

vi.mock('@ebda/database', () => ({
  prisma: {
    order: { findFirst: (...a: unknown[]) => h.orderFindFirst(...a), update: vi.fn() },
    payment: {
      findFirst: (...a: unknown[]) => h.paymentFindFirst(...a),
      create: (...a: unknown[]) => h.paymentCreate(...a),
    },
    paymentConfig: { findFirst: (...a: unknown[]) => h.paymentConfigFindFirst(...a) },
    // the storefront is read beside the order (NEON-ZERO: a Durable Object order cannot join the Store row)
    store: { findUnique: async () => ({ domain: null, slug: 'demo', ownerId: 'owner-1' }) },
  },
  runInTenantContext: async (_s: string, fn: () => unknown) => {
    const out = await fn();
    if (h.commitFails) {
      h.commitFails = false; // only the payment wrap's COMMIT fails
      throw new Error('COMMIT failed (simulated P2028)');
    }
    return out;
  },
  // Reads before the payment wrap (the order, the existing payment) never fail.
  withStore: async (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/definer', () => ({ getOrderStoreId: async () => 'store-1' }));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (_req: any, _res: any, next: any) => next(),
  optionalAuthenticate: (_req: any, _res: any, next: any) => next(),
  rejectImpersonated: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/rbac', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({
  paymentLimiter: (_req: any, _res: any, next: any) => next(),
  uploadLimiter: (_req: any, _res: any, next: any) => next(),
  dailyUploadLimiter: (_req: any, _res: any, next: any) => next(),
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@api/utils/store-helpers', () => ({
  getAuthUser: (req: any) => req.user,
  resolvePublicStoreId: async () => undefined,
}));
vi.mock('@api/services/payment-providers/payment.factory', () => ({
  // The route calls the provider in two halves; a COMMIT failure hits the second.
  PaymentService: {
    requestProviderPayment: async (...a: unknown[]) => ({
      providerName: 'paymob',
      response: await h.createPayment(...a),
    }),
    recordProviderPayment: vi.fn().mockResolvedValue(undefined),
    // the COD row (+ its created event) is written by the service, inside the payment wrap
    recordCodPayment: async (...a: unknown[]) => ({ id: (await h.paymentCreate(...a)).id }),
    getDefaultProvider: async () => 'paymob',
    getAvailableProviders: async () => [],
  },
}));
vi.mock('@api/services/payment-providers/orphaned-invoice-alert', () => ({
  alertOrphanedProviderInvoice: (...a: unknown[]) => h.orphanAlert(...a),
}));
vi.mock('@api/services/payment-event.service', () => ({ recordPaymentEvent: vi.fn() }));
vi.mock('@api/services/order.service', () => ({
  OrderService: {
    rollbackForPaymentFailure: async (...a: unknown[]) => {
      h.rollbackCalls.push(a);
    },
  },
}));
vi.mock('@api/config', () => ({
  config: { webUrl: 'https://store.test', apiUrl: 'https://api.test' },
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
let app: Express;
beforeAll(async () => {
  const { default: router } = await import('@api/routes/payment.routes');
  app = express();
  app.use(express.json());
  app.use('/api/v1/payments', router);
  app.use((_err: unknown, _req: any, res: any, _next: any) => res.status(500).end());
});
beforeEach(() => {
  vi.clearAllMocks();
  h.rollbackCalls = [];
  h.commitFails = false;
  h.orderFindFirst.mockResolvedValue({
    id: ORDER_ID,
    storeId: 'store-1',
    orderNumber: 'ORD-1',
    status: 'pending',
    total: 5000,
    walletAmount: 0,
    manualHoldAdmitted: true,
    currency: 'EGP',
    items: [],
    customer: null,
    shippingAddress: { email: 'g@example.com' },
    store: { domain: null, slug: 'demo' },
  });
  h.paymentFindFirst.mockResolvedValue(null);
  h.paymentCreate.mockResolvedValue({ id: 'pay-1' });
  h.paymentConfigFindFirst.mockResolvedValue({ fixedFee: 0 });
  h.createPayment.mockResolvedValue({
    transactionId: 'txn-1',
    paymentUrl: 'https://gw.test/pay',
    provider: 'paymob',
  });
});

const create = (provider: string) =>
  request(app)
    .post('/api/v1/payments/create')
    .set('x-session-id', 'sess-1')
    .send({ orderId: ORDER_ID, provider });

describe('POST /payments/create — rollback survives a failed COMMIT (issue 2306)', () => {
  it.each(['cod', 'instapay'])(
    'refuses uncapped gateway-to-%s conversion before creating a payment',
    async provider => {
      h.orderFindFirst.mockResolvedValueOnce({
        id: ORDER_ID,
        storeId: 'store-1',
        orderNumber: 'ORD-1',
        status: 'pending',
        total: 5000,
        walletAmount: 0,
        currency: 'EGP',
        manualHoldAdmitted: false,
        items: [],
        customer: null,
        shippingAddress: {},
        store: { domain: null, slug: 'demo' },
      });
      const res = await create(provider);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('MANUAL_HOLD_NOT_ADMITTED');
      expect(h.paymentCreate).not.toHaveBeenCalled();
      expect(h.createPayment).not.toHaveBeenCalled();
    }
  );

  it('online: provider accepted, COMMIT fails → the order is rolled back', async () => {
    h.commitFails = true;
    const res = await create('paymob');
    expect(res.status).toBe(500);
    expect(h.rollbackCalls).toEqual([['store-1', ORDER_ID, 'sess-1']]);
  });

  // issue 2360: the rollback cannot reach the gateway — the accepted invoice is
  // still live with no Payment row behind it, so it must be named in a P1.
  it('online: provider accepted, COMMIT fails → the live invoice is alerted', async () => {
    h.commitFails = true;
    await create('paymob');
    expect(h.orphanAlert).toHaveBeenCalledTimes(1);
    expect(h.orphanAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: 'store-1',
        orderId: ORDER_ID,
        provider: 'paymob',
        transactionId: 'txn-1',
        amount: 5000,
        source: 'checkout',
      })
    );
  });

  // The OTHER half — the provider ACCEPTED and the Payment row write threw —
  // is alerted inside PaymentService.createPayment itself (issue 2370), which
  // this file mocks out: tests/unit/payment-create-orphaned-record.test.ts.
  it('online: provider REJECTED → no orphaned-invoice alert (nothing was minted)', async () => {
    h.createPayment.mockRejectedValueOnce(new Error('gateway 400'));
    const res = await create('paymob');
    expect(res.status).toBe(500);
    expect(h.rollbackCalls).toEqual([['store-1', ORDER_ID, 'sess-1']]);
    expect(h.orphanAlert).not.toHaveBeenCalled();
  });

  it('cod: COMMIT fails → no orphaned-invoice alert (no gateway involved)', async () => {
    h.commitFails = true;
    await create('cod');
    expect(h.orphanAlert).not.toHaveBeenCalled();
  });

  it('cod: payment row written, COMMIT fails → the order is rolled back', async () => {
    h.commitFails = true;
    const res = await create('cod');
    expect(res.status).toBe(500);
    expect(h.rollbackCalls).toEqual([['store-1', ORDER_ID, 'sess-1']]);
  });

  it('a committed payment is never rolled back (control)', async () => {
    const res = await create('paymob');
    expect(res.status).toBe(200);
    expect(h.rollbackCalls).toEqual([]);
    expect(h.orphanAlert).not.toHaveBeenCalled();
  });
});
