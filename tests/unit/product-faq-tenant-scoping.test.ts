/**
 * Product FAQ CRUD — cross-tenant IDOR regression guard.
 *
 * apps/api/src/routes/product.routes.ts `/:id/faqs*` (mounted at
 * `/stores/:storeId/products`) used to query ProductFaq keyed only off
 * `productId: req.params.id`, never checking the product belongs to
 * `req.params.storeId`. Since ProductFaq has no storeId column, a
 * store_admin authenticated for store A could read/write/delete FAQs on a
 * product owned by store B just by passing that product's id — a live
 * exploitable IDOR under the BYPASSRLS app role.
 *
 * Fix: every handler now does `prisma.product.findFirst({ id, storeId })`
 * first and throws AppError(404) when it doesn't match, before touching
 * ProductFaq. This test extracts the 4 handlers directly off the router's
 * route stack (same technique as bulk-ai-catalogue-sweep-routes.test.ts)
 * so it exercises the exact production code without booting the full app
 * or its auth middleware chain (which requireStoreAccess already covers
 * elsewhere — this test is only about the productId->storeId check).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockProductFindFirst = vi.fn();
const mockFaqFindMany = vi.fn();
const mockFaqCreate = vi.fn();
const mockFaqUpdateMany = vi.fn();
const mockFaqFindUnique = vi.fn();
const mockFaqDeleteMany = vi.fn();

vi.mock('@ebda/database', () => ({
  prisma: {
    product: { findFirst: (...args: unknown[]) => mockProductFindFirst(...args) },
    productFaq: {
      findMany: (...args: unknown[]) => mockFaqFindMany(...args),
      create: (...args: unknown[]) => mockFaqCreate(...args),
      updateMany: (...args: unknown[]) => mockFaqUpdateMany(...args),
      findUnique: (...args: unknown[]) => mockFaqFindUnique(...args),
      deleteMany: (...args: unknown[]) => mockFaqDeleteMany(...args),
    },
  },
}));

vi.mock('../../apps/api/src/middleware/auth', () => ({
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
  authorize: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../apps/api/src/middleware/store-access', () => ({
  requireStoreAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../apps/api/src/middleware/security', () => ({
  writeLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  auditLog: vi.fn(),
}));
vi.mock('../../apps/api/src/middleware/feature-gate', () => ({
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../apps/api/src/services/product.service', () => ({
  ProductService: {},
}));
vi.mock('../../apps/api/src/lib/public-cache', () => ({
  invalidateStoreProductCaches: vi.fn(),
}));

import productRoutes from '../../apps/api/src/routes/product.routes';

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (...args: unknown[]) => unknown }>;
  };
}

function getHandler(method: 'get' | 'post' | 'put' | 'delete', path: string) {
  const layers = (productRoutes as unknown as { stack: RouteLayer[] }).stack;
  const layer = layers.find(l => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`Route ${method.toUpperCase()} ${path} not found`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (
    req: unknown,
    res: unknown,
    next: (err?: unknown) => void
  ) => Promise<void>;
}

function mockReqRes(params: Record<string, string>, body: object = {}) {
  const req = { params, body, user: { userId: 'user-1' } };
  const jsonMock = vi.fn();
  const statusMock = vi.fn(() => ({ json: jsonMock }));
  const res = { status: statusMock, json: jsonMock };
  const next = vi.fn();
  return { req, res, statusMock, jsonMock, next };
}

const STORE_A = 'store-a';
const PRODUCT_OF_STORE_B = 'product-owned-by-store-b';

describe('Product FAQ routes — cross-tenant scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /:id/faqs returns 404 when the product belongs to another store', async () => {
    mockProductFindFirst.mockResolvedValue(null); // not found for store A
    const handler = getHandler('get', '/:id/faqs');
    const { req, next } = mockReqRes({ storeId: STORE_A, id: PRODUCT_OF_STORE_B });

    await handler(req, {}, next);

    expect(mockProductFindFirst).toHaveBeenCalledWith({
      where: { id: PRODUCT_OF_STORE_B, storeId: STORE_A },
      select: { id: true },
    });
    expect(mockFaqFindMany).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 404, code: 'NOT_FOUND' })
    );
  });

  it('GET /:id/faqs returns the FAQs for a product owned by the authenticated store (control)', async () => {
    mockProductFindFirst.mockResolvedValue({ id: 'product-a' });
    mockFaqFindMany.mockResolvedValue([{ id: 'faq-1', question: 'Q?' }]);
    const handler = getHandler('get', '/:id/faqs');
    const { req, res, jsonMock, next } = mockReqRes({ storeId: STORE_A, id: 'product-a' });

    await handler(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, data: [{ id: 'faq-1', question: 'Q?' }] })
    );
  });

  it('POST /:id/faqs returns 404 for a cross-tenant product and never creates the FAQ', async () => {
    mockProductFindFirst.mockResolvedValue(null);
    const handler = getHandler('post', '/:id/faqs');
    const { req, next } = mockReqRes(
      { storeId: STORE_A, id: PRODUCT_OF_STORE_B },
      { question: 'Q', answer: 'A' }
    );

    await handler(req, {}, next);

    expect(mockFaqCreate).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });

  it('PUT /:id/faqs/:faqId returns 404 for a cross-tenant product and never updates', async () => {
    mockProductFindFirst.mockResolvedValue(null);
    const handler = getHandler('put', '/:id/faqs/:faqId');
    const { req, next } = mockReqRes(
      { storeId: STORE_A, id: PRODUCT_OF_STORE_B, faqId: 'faq-1' },
      { answer: 'new answer' }
    );

    await handler(req, {}, next);

    expect(mockFaqUpdateMany).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });

  it('DELETE /:id/faqs/:faqId returns 404 for a cross-tenant product and never deletes', async () => {
    mockProductFindFirst.mockResolvedValue(null);
    const handler = getHandler('delete', '/:id/faqs/:faqId');
    const { req, next } = mockReqRes({
      storeId: STORE_A,
      id: PRODUCT_OF_STORE_B,
      faqId: 'faq-1',
    });

    await handler(req, {}, next);

    expect(mockFaqDeleteMany).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });

  it('DELETE /:id/faqs/:faqId deletes the FAQ for a same-tenant product (control)', async () => {
    mockProductFindFirst.mockResolvedValue({ id: 'product-a' });
    mockFaqDeleteMany.mockResolvedValue({ count: 1 });
    const handler = getHandler('delete', '/:id/faqs/:faqId');
    const { req, res, jsonMock, next } = mockReqRes({
      storeId: STORE_A,
      id: 'product-a',
      faqId: 'faq-1',
    });

    await handler(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockFaqDeleteMany).toHaveBeenCalledWith({
      where: { id: 'faq-1', productId: 'product-a' },
    });
    expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});
