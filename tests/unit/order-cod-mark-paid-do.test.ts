/**
 * NEON-ZERO-1 group A (Ruling NZ-A-2): COD mark-paid on a Durable Object store records its payment events, fan-out and counts
 * from what the DO section ACTUALLY updated, never from the requested list. A bulk request with one already-paid order books
 * exactly one event for the order that moved, using the payment row the section flipped.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const findMany = vi.fn();
const codMarkPaid = vi.fn();
const eventForStore = vi.fn(async () => undefined);
const inngestSend = vi.fn(async () => undefined);
vi.mock('@ebda/database', () => ({
  prisma: {},
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({ order: { findMany: (...a: unknown[]) => findMany(...a) } }),
  storeMoney: async () => ({ codMarkPaid: (...a: unknown[]) => codMarkPaid(...a) }),
}));
vi.mock('@api/lib/jobs/store-db', () => ({
  customersById: vi.fn(),
  runInStoreCtx: (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/middleware/auth', () => ({
  rejectImpersonated: (_r: any, _s: any, n: any) => n(),
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: 'store_admin' };
    next();
  },
  authorize: () => (_r: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_r: any, _s: any, n: any) => n(),
  checkStoreAccess: vi.fn(),
}));
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: () => (_r: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/rbac', () => ({
  requirePermission: () => (_r: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/security', () => ({
  auditLog: vi.fn(async () => undefined),
  writeLimiter: (_r: any, _s: any, n: any) => n(),
}));
vi.mock('@api/utils/store-helpers', () => ({ getAuthUser: (req: any) => req.user }));
vi.mock('@api/services/payment-providers/payment.factory', () => ({ PaymentService: {} }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/inngest/client', () => ({
  inngest: { send: (...a: unknown[]) => inngestSend(...a) },
}));
vi.mock('@api/services/payment-event.service', () => ({
  recordPaymentEvent: vi.fn(),
  recordPaymentEventForStore: (...a: unknown[]) => eventForStore(...(a as [])),
}));
vi.mock('@api/services/payment-confirm.service', () => ({
  confirmPaymentFromProviderStatus: vi.fn(),
}));
vi.mock('@api/services/order.service', () => ({ OrderService: {} }));
vi.mock('@api/services/invoice.service', () => ({ InvoiceService: {} }));
vi.mock('@api/lib/audit-actors', () => ({ listAuditWithActors: vi.fn() }));
vi.mock('@api/config', () => ({ config: {} }));
vi.mock('exceljs', () => ({ default: class {} }));
vi.mock('@api/lib/exports/xlsx', () => ({ neutralizeRowObject: vi.fn() }));

const STORE = '11111111-1111-4111-8111-111111111111';
const O1 = '22222222-2222-4222-8222-222222222221';
const O2 = '22222222-2222-4222-8222-222222222222';
let app: Express;

beforeAll(async () => {
  const { default: router } = await import('@api/routes/order.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  app = express();
  app.use(express.json());
  app.use('/api/v1/stores/:storeId/orders', router);
  app.use(errorHandler);
});

const row = (id: string, n: string, payId: string) => ({
  id,
  storeId: STORE,
  orderNumber: n,
  status: 'pending',
  payments: [{ id: payId, status: 'cod_pending', provider: 'cod' }],
});

describe('bulk COD mark-paid on a Durable Object store', () => {
  it('books one event and one fan-out for the one order the section updated', async () => {
    findMany.mockResolvedValue([
      row(O1, 'N-1', 'pay-requested-1'),
      row(O2, 'N-2', 'pay-requested-2'),
    ]);
    // O2 was paid by someone else in the meantime: the section skips it, and flipped a different payment row for O1
    codMarkPaid.mockResolvedValue({
      updated: [
        { orderId: O1, paymentId: 'pay-flipped-1', fromStatus: 'pending', orderNumber: 'N-1' },
      ],
    });
    const res = await request(app)
      .post(`/api/v1/stores/${STORE}/orders/bulk-mark-paid`)
      .send({ orderIds: [O1, O2] });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ updated: 1, skipped: 1 });
    expect(eventForStore).toHaveBeenCalledTimes(1);
    expect(eventForStore.mock.calls[0][0]).toMatchObject({
      paymentId: 'pay-flipped-1',
      orderId: O1,
      fromStatus: 'pending',
      toStatus: 'completed',
    });
    expect(inngestSend).toHaveBeenCalledTimes(1);
  });
});
