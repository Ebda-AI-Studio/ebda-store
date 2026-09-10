/**
 * API contract for the merchant-authored product card badge.
 *
 * Two layers, because the field can be lost at either:
 *
 *   1. `updateProductSchema` (product.routes.ts) — trims, caps at 32 chars,
 *      accepts `null` to clear, and leaves an omitted key absent. Zod is
 *      strict (`z.object`, no `.passthrough()`), so a field not listed there
 *      is silently STRIPPED: the PUT returns 200, `updatedAt` moves, and the
 *      merchant's badge never changes. That is the exact shape of the
 *      clear-on-empty defect this branch already carries a gate for.
 *
 *   2. `ProductService.update` — must spread the column only when the key is
 *      present, so `null` clears and an omitted key leaves the stored value
 *      alone (Prisma's convention). A plain `badgeLabel: data.badgeLabel`
 *      would wipe the badge on every unrelated save.
 *
 * Everything is imported from SOURCE, never through `@force/shared` or a
 * built package — a schema test resolved to `packages/shared/dist` passes on
 * the last build instead of on the code under review.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
// NOTE the explicit `/index.ts`. `packages/shared/src/types/` carries a
// TRACKED, STALE `index.js` (a committed build artifact that predates this
// branch), and Vite resolves a bare directory import to the `.js` first — so
// `@shared/src/types` silently hands back the OLD module and this constant
// comes through as `undefined`, turning every length assertion into a
// no-op that passes. Same trap as importing `@force/shared` (→ dist) in a
// schema test, one directory deeper.
import { PRODUCT_BADGE_LABEL_MAX_LENGTH } from '@shared/src/types/index.ts';

const STORE_ID = '11111111-1111-1111-1111-111111111111';
const PRODUCT_ID = '22222222-2222-2222-2222-222222222222';

const { updateMock, findFirstMock, productUpdateMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  findFirstMock: vi.fn(),
  productUpdateMock: vi.fn(),
}));

// ─── Layer 1: the route + its Zod schema ────────────────────────────────────

vi.mock('@api/services/product.service', () => ({
  ProductService: { update: updateMock },
  STOREFRONT_PRODUCT_SELECT: {},
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
  requirePermission: (_p: string) => (_req: any, _res: any, next: any) => next(),
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

vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@force/database', () => ({
  prisma: {
    product: { findFirst: findFirstMock, update: productUpdateMock, findMany: vi.fn() },
    category: { findMany: vi.fn().mockResolvedValue([]) },
    productImage: { deleteMany: vi.fn(), createMany: vi.fn() },
    productCategory: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    review: { aggregate: vi.fn() },
  },
  Prisma: {},
  ProductStatus: {},
  OrderStatus: {},
  SlugEntityType: { PRODUCT: 'PRODUCT' },
  withMoneyTx: vi.fn(async (_p: unknown, cb: (tx: unknown) => unknown) =>
    cb({
      product: { update: productUpdateMock },
      productImage: { deleteMany: vi.fn(), createMany: vi.fn() },
      productCategory: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn(),
        createMany: vi.fn(),
      },
    })
  ),
  runInTenantContext: (_storeId: string, fn: () => unknown) => fn(),
}));

describe('PUT /stores/:storeId/products/:id — badge label schema', () => {
  let app: Express;

  beforeAll(async () => {
    const { default: productRouter } = await import('@api/routes/product.routes');
    const { errorHandler } = await import('@api/middleware/error-handler');
    app = express();
    app.use(express.json());
    app.use('/api/v1/stores/:storeId/products', productRouter);
    app.use(errorHandler);
  });

  beforeEach(() => {
    updateMock.mockReset();
    updateMock.mockImplementation(async (_s: string, id: string, data: unknown) => ({
      id,
      ...(data as object),
    }));
  });

  async function put(body: Record<string, unknown>) {
    return request(app).put(`/api/v1/stores/${STORE_ID}/products/${PRODUCT_ID}`).send(body);
  }

  /** The payload the service actually received. */
  function received(): Record<string, unknown> {
    return updateMock.mock.calls[0][2];
  }

  for (const field of ['badgeLabel', 'badgeLabelAr'] as const) {
    describe(field, () => {
      it('a value is stored exactly as typed', async () => {
        const value = field === 'badgeLabelAr' ? 'عرض' : 'Offer';
        const res = await put({ [field]: value });
        expect(res.status).toBe(200);
        expect(received()[field]).toBe(value);
      });

      it('null CLEARS the column', async () => {
        const res = await put({ [field]: null });
        expect(res.status).toBe(200);
        expect(received()[field]).toBeNull();
      });

      it('an omitted key leaves the stored value untouched', async () => {
        // Absent, not null: Prisma reads an omitted key as "leave alone", and
        // a schema that defaulted it to null would wipe every merchant's
        // badge on the next unrelated save.
        const res = await put({ status: 'active' });
        expect(res.status).toBe(200);
        expect(field in received()).toBe(false);
        expect(received()[field]).toBeUndefined();
      });

      it('trims surrounding whitespace instead of storing it', async () => {
        const res = await put({ [field]: '  Offer  ' });
        expect(res.status).toBe(200);
        expect(received()[field]).toBe('Offer');
      });

      it('a whitespace-only value is a clear, not a two-space label', async () => {
        const res = await put({ [field]: '   ' });
        expect(res.status).toBe(200);
        expect(received()[field]).toBeNull();
      });

      it('an empty string is a clear', async () => {
        const res = await put({ [field]: '' });
        expect(res.status).toBe(200);
        expect(received()[field]).toBeNull();
      });

      it(`accepts exactly ${PRODUCT_BADGE_LABEL_MAX_LENGTH} characters`, async () => {
        const value = 'x'.repeat(PRODUCT_BADGE_LABEL_MAX_LENGTH);
        const res = await put({ [field]: value });
        expect(res.status).toBe(200);
        expect(received()[field]).toBe(value);
      });

      it('accepts a max-length label padded with spaces (trim happens first)', async () => {
        const value = 'x'.repeat(PRODUCT_BADGE_LABEL_MAX_LENGTH);
        const res = await put({ [field]: `   ${value}   ` });
        expect(res.status).toBe(200);
        expect(received()[field]).toBe(value);
      });

      it('REJECTS an over-length label instead of truncating it', async () => {
        // Truncating would ship a label the merchant never wrote; storing it
        // whole would overflow the VARCHAR(32) column and 500 at the DB.
        const res = await put({ [field]: 'x'.repeat(PRODUCT_BADGE_LABEL_MAX_LENGTH + 1) });
        expect(res.status).toBe(400);
        expect(updateMock).not.toHaveBeenCalled();
      });

      it('rejects a long Arabic label the same way', async () => {
        const res = await put({ [field]: 'ع'.repeat(PRODUCT_BADGE_LABEL_MAX_LENGTH + 1) });
        expect(res.status).toBe(400);
      });

      it('rejects a non-string', async () => {
        const res = await put({ [field]: 42 });
        expect(res.status).toBe(400);
      });
    });
  }

  it('is NOT silently stripped by the strict schema (the listed-key trap)', async () => {
    const res = await put({ badgeLabel: 'Offer', badgeLabelAr: 'عرض' });
    expect(res.status).toBe(200);
    expect(received()).toMatchObject({ badgeLabel: 'Offer', badgeLabelAr: 'عرض' });
  });

  it('clears one language while setting the other', async () => {
    const res = await put({ badgeLabel: null, badgeLabelAr: 'عرض' });
    expect(res.status).toBe(200);
    expect(received().badgeLabel).toBeNull();
    expect(received().badgeLabelAr).toBe('عرض');
  });
});

// ─── Layer 2: the service write semantics ───────────────────────────────────

describe('ProductService.update — badge write semantics', () => {
  let ProductService: typeof import('@api/services/product.service').ProductService;

  beforeAll(async () => {
    // The route block above mocks the whole service module; this block needs
    // the REAL one, so it is imported through a module registry reset.
    vi.resetModules();
    vi.doUnmock('@api/services/product.service');
    vi.doMock('@api/services/ai-autofill.service', () => ({
      stampHumanEdits: () => ({}),
    }));
    vi.doMock('@api/services/redis.service', () => ({
      redis: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), deleteByPrefix: vi.fn() },
    }));
    vi.doMock('@api/services/r2-cleanup.service', () => ({ cleanupRemovedImages: vi.fn() }));
    vi.doMock('@api/services/slug-redirect.service', () => ({ recordSlugRedirect: vi.fn() }));
    vi.doMock('@api/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => {}) } }));
    ({ ProductService } = await import('@api/services/product.service'));
  });

  const STORED = {
    id: PRODUCT_ID,
    storeId: STORE_ID,
    slug: 'schools-offer',
    name: "School's Offer",
    price: 5000,
    inventory: 10,
    lowStockThreshold: 5,
    allowBackorder: false,
    badgeLabel: 'Offer',
    badgeLabelAr: 'عرض',
    aiFieldSources: {},
    images: [],
    categories: [],
    options: [],
    variants: [],
  };

  beforeEach(() => {
    findFirstMock.mockReset();
    findFirstMock.mockResolvedValue(STORED);
    productUpdateMock.mockReset();
    productUpdateMock.mockImplementation(async ({ data }: any) => ({
      ...STORED,
      ...data,
      images: [],
      categories: [],
    }));
  });

  /** The Prisma `data` object the update actually wrote. */
  function written(): Record<string, unknown> {
    return productUpdateMock.mock.calls[0][0].data;
  }

  it('writes null when the caller sends null (the merchant cleared it)', async () => {
    await ProductService.update(STORE_ID, PRODUCT_ID, { badgeLabel: null } as never);
    expect(written().badgeLabel).toBeNull();
  });

  it('writes the value when the caller sends one', async () => {
    await ProductService.update(STORE_ID, PRODUCT_ID, { badgeLabelAr: 'خصم' } as never);
    expect(written().badgeLabelAr).toBe('خصم');
  });

  it('OMITS the key entirely when the caller omits it', async () => {
    // Not `badgeLabel: undefined` in the Prisma payload by accident either —
    // the key must not be present at all, so an unrelated save (a stock
    // edit, a status flip) can never wipe a badge.
    await ProductService.update(STORE_ID, PRODUCT_ID, { status: 'active' } as never);
    expect('badgeLabel' in written()).toBe(false);
    expect('badgeLabelAr' in written()).toBe(false);
  });

  it('clears one language and leaves the other untouched', async () => {
    await ProductService.update(STORE_ID, PRODUCT_ID, { badgeLabel: null } as never);
    expect(written().badgeLabel).toBeNull();
    expect('badgeLabelAr' in written()).toBe(false);
  });
});
