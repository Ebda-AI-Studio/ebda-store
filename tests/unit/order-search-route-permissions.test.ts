/**
 * Security review (Task 14): the store-wide order / customer search lookups
 * (`ebda_order_search_ids`) answer for the WHOLE store, and staff permissions live only in the app
 * layer. So every route that reaches them must enforce `orders:read` before calling:
 *   - GET /stores/:storeId/customers/search
 *   - GET /stores/:storeId/orders/export.xlsx
 *   - GET /stores/:storeId/orders (store viewers; a customer searching their own orders never
 *     calls the store-wide lookup, see orderSearchWhere `indexed: false`)
 *
 * Behaviour, not source text: the REAL routers are mounted (supertest) and the permission layer
 * is told `orders:read` is denied. Every shipped store-viewer role holds `orders:read` today, so a
 * denied permission is the only way to prove the guard is wired. The store-wide lookup, the
 * export query and the order list must then never run. Mutation: remove the guard, test red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  denied: new Set<string>(),
  role: 'staff',
  searchOrderCustomers: vi.fn(),
  storeDb: vi.fn(),
  orderList: vi.fn(),
}));

vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'u1', role: h.role };
    next();
  },
  authorize: () => (_req: any, _res: any, next: any) => next(),
  rejectImpersonated: (_req: any, _res: any, next: any) => next(),
  customerUserId: () => undefined,
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
  checkStoreAccess: async () => ({ ok: true }),
}));
vi.mock('@api/middleware/customer-store-match', () => ({
  requireCustomerStoreMatch: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/security', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
  writeLimiter: (_req: any, _res: any, next: any) => next(),
}));
// The permission layer: same contract as the real one (403 FORBIDDEN, next() when held), but the
// test decides which permission is missing.
vi.mock('@api/middleware/rbac', () => ({
  hasPermission: (_role: string, p: string) => !h.denied.has(p),
  requirePermission: (p: string) => (_req: any, res: any, next: any) =>
    h.denied.has(p)
      ? res.status(403).json({ success: false, error: { code: 'FORBIDDEN' } })
      : next(),
}));
vi.mock('@api/services/customer-search.service', () => ({
  searchOrderCustomers: (...a: unknown[]) => h.searchOrderCustomers(...a),
}));
vi.mock('@api/lib/repo-factory', () => ({ storeDb: (...a: unknown[]) => h.storeDb(...a) }));
vi.mock('@api/services/order.service', () => ({
  OrderService: { list: (...a: unknown[]) => h.orderList(...a) },
  assertValidTransition: vi.fn(),
}));
vi.mock('@api/services/invoice.service', () => ({ InvoiceService: {} }));
vi.mock('@api/services/payment-providers/payment.factory', () => ({ PaymentService: {} }));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/public-cache', () => ({
  invalidateCached: vi.fn(),
  invalidateCachedPrefix: vi.fn(),
  invalidateStoreProductCaches: vi.fn(),
  invalidateCustomersCache: vi.fn(),
}));
vi.mock('exceljs', () => ({ default: class {} }));

const STORE = '11111111-1111-4111-8111-111111111111';

async function app() {
  const { default: customers } = await import('@api/routes/customers.routes');
  const { default: orders } = await import('@api/routes/order.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  const server = express();
  server.use('/api/v1/stores/:storeId', customers);
  server.use('/api/v1/stores/:storeId/orders', orders);
  server.use(errorHandler);
  return server;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.denied.clear();
  h.role = 'staff';
  h.searchOrderCustomers.mockResolvedValue([]);
  h.orderList.mockResolvedValue({ orders: [], total: 0 });
  h.storeDb.mockRejectedValue(new Error('the export query must not run'));
});

describe('order / customer search routes enforce orders:read', () => {
  it('customers/search', async () => {
    h.denied.add('orders:read');
    const res = await request(await app())
      .get(`/api/v1/stores/${STORE}/customers/search`)
      .set('X-Search-Query', encodeURIComponent('ahmed'));
    expect(res.status).toBe(403);
    expect(h.searchOrderCustomers).not.toHaveBeenCalled();
  });
  it('orders export', async () => {
    h.denied.add('orders:read');
    const res = await request(await app()).get(`/api/v1/stores/${STORE}/orders/export.xlsx`);
    expect(res.status).toBe(403);
    expect(h.storeDb).not.toHaveBeenCalled();
  });
  it('orders list: a store viewer needs orders:read', async () => {
    h.denied.add('orders:read');
    const res = await request(await app()).get(`/api/v1/stores/${STORE}/orders`);
    expect(res.status).toBe(403);
    expect(h.orderList).not.toHaveBeenCalled();
  });
  it('orders list: a customer never meets the store viewer permission check', async () => {
    h.role = 'customer';
    h.denied.add('orders:read');
    const res = await request(await app()).get(`/api/v1/stores/${STORE}/orders`);
    expect(res.status).toBe(200);
    expect(h.orderList).toHaveBeenCalledWith(
      STORE,
      expect.objectContaining({ customerId: 'u1', confirmedOnly: false })
    );
  });

  it('customers/search caps the term length before it reaches the definer (review M-4)', async () => {
    const res = await request(await app())
      .get(`/api/v1/stores/${STORE}/customers/search`)
      .set('X-Search-Query', encodeURIComponent('a'.repeat(500)));
    expect(res.status).toBe(200);
    expect(h.searchOrderCustomers).toHaveBeenCalledTimes(1);
    expect(h.searchOrderCustomers).toHaveBeenCalledWith(STORE, 'a'.repeat(100));
    // the deprecated query-string form is bounded by the same helper
    h.searchOrderCustomers.mockClear();
    await request(await app()).get(`/api/v1/stores/${STORE}/customers/search?q=${'b'.repeat(500)}`);
    expect(h.searchOrderCustomers).toHaveBeenCalledWith(STORE, 'b'.repeat(100));
  });
});
