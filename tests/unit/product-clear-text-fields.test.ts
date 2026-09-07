/**
 * Route-level test for the "an emptied text field must clear" defect.
 *
 * A merchant emptied a product's English description in admin and saved. The
 * PUT succeeded and `updatedAt` moved, but the 226-character description
 * survived — clearing was impossible through the UI. Three layers conspired:
 *
 *   1. `createProductSchema` typed `description` as `z.string().optional()`,
 *      so an explicit `null` was REJECTED (400) before it reached the service.
 *   2. the service wrote `description: data.description`, which Prisma reads
 *      as "leave alone" for `undefined` — correct, but `null` never arrived.
 *   3. the admin edit form sent `formData.description || undefined`, so an
 *      emptied textarea omitted the key entirely.
 *
 * The convention (already correct for `excerpt` / the SEO meta columns) is
 * Prisma's: `null` clears, `undefined` (omitted key) leaves alone. These
 * tests drive the real router + real service over a mocked Prisma, so they
 * cover the Zod schema AND the data actually handed to `product.update`.
 *
 * Same app-bootstrap pattern as tests/unit/coupon-targeting-route.test.ts.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const { mockPrisma, txMock } = vi.hoisted(() => {
  const txMock = {
    product: { update: vi.fn() },
    productImage: { deleteMany: vi.fn(), createMany: vi.fn() },
    productCategory: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
  };
  return {
    txMock,
    mockPrisma: {
      product: { findFirst: vi.fn(), update: vi.fn() },
      category: { findMany: vi.fn() },
    },
  };
});

vi.mock('@force/database', () => ({
  prisma: mockPrisma,
  Prisma: {},
  ProductStatus: {},
  OrderStatus: {},
  SlugEntityType: { PRODUCT: 'PRODUCT', CATEGORY: 'CATEGORY' },
  withMoneyTx: (_prisma: unknown, cb: (tx: unknown) => unknown) => cb(txMock),
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

vi.mock('@api/middleware/rbac', () => ({
  requirePermission:
    (..._args: unknown[]) =>
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

vi.mock('@api/middleware/security', () => ({
  auditLog: vi.fn(),
  writeLimiter: (_req: any, _res: any, next: any) => next(),
  publicTenantLimiter: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@api/lib/public-cache', () => ({
  invalidateCached: vi.fn(),
  invalidateCachedPrefix: vi.fn(),
  invalidateStoreProductCaches: vi.fn(),
  invalidateStoreCategoriesCaches: vi.fn(),
  getCached: vi.fn(),
  setEdgeCache: vi.fn(),
}));

vi.mock('@api/services/redis.service', () => ({
  redis: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), deletePattern: vi.fn() },
}));

vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@api/services/r2-cleanup.service', () => ({
  cleanupRemovedImages: vi.fn(),
}));

vi.mock('@api/lib/inngest/client', () => ({
  inngest: { send: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@api/services/slug-redirect.service', () => ({
  recordSlugRedirect: vi.fn(),
}));

let app: Express;

async function buildApp(): Promise<Express> {
  const { default: productRouter } = await import('@api/routes/product.routes');
  const { errorHandler } = await import('@api/middleware/error-handler');
  const server = express();
  server.use(express.json());
  server.use('/api/v1/stores/:storeId/products', productRouter);
  server.use(errorHandler);
  return server;
}

const STORE_ID = '11111111-1111-1111-1111-111111111111';
const PRODUCT_ID = '22222222-2222-2222-2222-222222222222';

/** The live row the merchant was editing: every clearable column is populated. */
const STORED_PRODUCT = {
  id: PRODUCT_ID,
  storeId: STORE_ID,
  name: 'Pecan Butter',
  nameAr: 'زبدة البيكان',
  slug: 'pecan-butter',
  description: 'A long English description the merchant wants gone.',
  descriptionAr: 'وصف عربي',
  sku: 'PB-001',
  price: 3500,
  inventory: 10,
  discountType: null,
  discountValue: null,
  aiFieldSources: {},
  images: [],
  categories: [],
  variants: [],
};

/** Every clearable field, and the value stored on STORED_PRODUCT. */
const CLEARABLE_FIELDS = [
  ['description', STORED_PRODUCT.description],
  ['descriptionAr', STORED_PRODUCT.descriptionAr],
  ['nameAr', STORED_PRODUCT.nameAr],
  ['sku', STORED_PRODUCT.sku],
] as const;

/** The `data` object the service handed to `tx.product.update`. */
function lastUpdateData(): Record<string, unknown> {
  expect(txMock.product.update).toHaveBeenCalledTimes(1);
  return (txMock.product.update.mock.calls[0][0] as any).data;
}

describe('PUT /stores/:storeId/products/:id — clearing an emptied text field', () => {
  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.product.findFirst.mockResolvedValue(STORED_PRODUCT);
    txMock.product.update.mockImplementation(({ data }: any) =>
      Promise.resolve({ ...STORED_PRODUCT, ...data })
    );
    txMock.productCategory.findMany.mockResolvedValue([]);
  });

  for (const [field, storedValue] of CLEARABLE_FIELDS) {
    describe(`${field}`, () => {
      it('is ACCEPTED as null by the Zod schema and clears the column', async () => {
        const res = await request(app)
          .put(`/api/v1/stores/${STORE_ID}/products/${PRODUCT_ID}`)
          .send({ [field]: null });

        // Before the fix this was a 400: `z.string().optional()` rejects null,
        // so the clear never even reached the service.
        expect(res.status).toBe(200);
        expect(lastUpdateData()[field]).toBeNull();
        expect(res.body.data.product[field]).toBeNull();
      });

      it('sets a non-empty value exactly as before', async () => {
        const res = await request(app)
          .put(`/api/v1/stores/${STORE_ID}/products/${PRODUCT_ID}`)
          .send({ [field]: 'new value' });

        expect(res.status).toBe(200);
        expect(lastUpdateData()[field]).toBe('new value');
      });

      it('leaves the stored value untouched when the key is omitted', async () => {
        const res = await request(app)
          .put(`/api/v1/stores/${STORE_ID}/products/${PRODUCT_ID}`)
          .send({ status: 'active' });

        expect(res.status).toBe(200);
        // Prisma reads a missing key (or `undefined`) as "leave alone" — the
        // patch must NOT carry a null it never asked for.
        const data = lastUpdateData();
        expect(data[field]).toBeUndefined();
        expect(res.body.data.product[field]).toBe(storedValue);
      });
    });
  }

  it('clears every field in one save, the way the edit form submits', async () => {
    const res = await request(app)
      .put(`/api/v1/stores/${STORE_ID}/products/${PRODUCT_ID}`)
      .send({ description: null, descriptionAr: null, nameAr: null, sku: null });

    expect(res.status).toBe(200);
    const data = lastUpdateData();
    for (const [field] of CLEARABLE_FIELDS) {
      expect(data[field]).toBeNull();
    }
  });

  it('omits the clearable keys entirely from the Prisma patch when not sent', async () => {
    // The service must build the patch the way `excerpt` / the SEO meta
    // columns already do — spread the key in ONLY when it is present. The
    // audit log reports `Object.keys(data)`, so a key the merchant never
    // touched must not appear in the write.
    const res = await request(app)
      .put(`/api/v1/stores/${STORE_ID}/products/${PRODUCT_ID}`)
      .send({ description: null });

    expect(res.status).toBe(200);
    const keys = Object.keys(lastUpdateData());
    expect(keys).toContain('description');
    expect(keys).not.toContain('descriptionAr');
    expect(keys).not.toContain('nameAr');
    expect(keys).not.toContain('sku');
  });

  it('still rejects a null `name` — the column is required, not clearable', async () => {
    const res = await request(app)
      .put(`/api/v1/stores/${STORE_ID}/products/${PRODUCT_ID}`)
      .send({ name: null });

    expect(res.status).toBe(400);
    expect(txMock.product.update).not.toHaveBeenCalled();
  });
});

describe('POST /stores/:storeId/products — create path is unchanged', () => {
  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.product.findFirst.mockResolvedValue(null); // slug is free
    mockPrisma.product.update.mockReset();
  });

  it('accepts a create with the optional text fields omitted', async () => {
    const createMock = vi
      .fn()
      .mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'new-1', images: [], categories: [], ...data })
      );
    (mockPrisma.product as any).create = createMock;

    const res = await request(app)
      .post(`/api/v1/stores/${STORE_ID}/products`)
      .send({ name: 'Fresh Pecans', price: 2500 });

    expect(res.status).toBe(201);
    const createData = createMock.mock.calls[0][0].data;
    expect(createData.description).toBeUndefined();
    expect(createData.nameAr).toBeUndefined();
    expect(createData.sku).toBeUndefined();
  });
});
