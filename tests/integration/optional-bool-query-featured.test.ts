/**
 * Optional boolean query params are tri-state (absent / true / false).
 *
 * The public and admin product lists used to pass `featured === 'true'` to
 * ProductService, so an ABSENT param became `featured: false`. The service
 * only skips the filter when it is `undefined`, so every default listing
 * (storefront Recommended / Newest / Price / Best-sellers, the admin product
 * list, the page-builder and order pickers) added `WHERE featured = false`
 * and silently hid every product a merchant had marked featured.
 *
 * Seeds one featured + one non-featured product and drives the real routers.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { withRlsBypass } from '@force/database';

vi.mock('@api/middleware/auth', async importOriginal => {
  const actual = await importOriginal<typeof import('@api/middleware/auth')>();
  return {
    ...actual,
    authenticate: (req: any, _res: any, next: any) => {
      req.user = { userId: 'admin-1', role: 'store_admin' };
      next();
    },
    authorize:
      (..._roles: string[]) =>
      (_req: any, _res: any, next: any) =>
        next(),
  };
});
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));

const hasDb =
  !!process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost:5432/test_db');

describe.skipIf(!hasDb)('optional boolean query params: featured filter', () => {
  const suffix = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const FEATURED = `bq-featured-${suffix}`;
  const PLAIN = `bq-plain-${suffix}`;
  let storeId: string;
  let app: Express;

  beforeAll(async () => {
    await withRlsBypass(async tx => {
      const owner = await tx.user.create({
        data: {
          email: `bq-owner-${suffix}@example.com`,
          passwordHash: 'not-a-real-hash',
          role: 'store_admin',
          firstName: 'BQ',
          lastName: 'Owner',
        },
      });
      const store = await tx.store.create({
        data: {
          name: 'bq-test-store',
          slug: `bq-test-${suffix}`,
          template: 'modern',
          currency: 'KWD',
          ownerId: owner.id,
          status: 'active',
        },
      });
      storeId = store.id;
      await tx.product.createMany({
        data: [
          {
            storeId,
            name: FEATURED,
            slug: FEATURED,
            price: 1000,
            inventory: 5,
            status: 'active',
            featured: true,
          },
          {
            storeId,
            name: PLAIN,
            slug: PLAIN,
            price: 2000,
            inventory: 5,
            status: 'active',
            featured: false,
          },
        ],
      });
    });

    const { default: publicRoutes } = await import('@api/routes/public.routes');
    const { default: productRoutes } = await import('@api/routes/product.routes');
    const { errorHandler } = await import('@api/middleware/error-handler');
    app = express();
    app.use(express.json());
    app.use('/api/v1/public', publicRoutes);
    app.use('/api/v1/stores/:storeId/products', productRoutes);
    app.use((err: unknown, req: Request, res: Response, next: NextFunction) =>
      errorHandler(err as any, req, res, next)
    );
  });

  afterAll(async () => {
    await withRlsBypass(async tx => {
      await tx.product.deleteMany({ where: { storeId } }).catch(() => {});
      await tx.store.deleteMany({ where: { id: storeId } }).catch(() => {});
      await tx.user.deleteMany({ where: { email: { contains: suffix } } }).catch(() => {});
    });
  });

  const names = (res: request.Response) =>
    (res.body.data.products as Array<{ name: string }>).map(p => p.name).sort();

  // Each public query gets a distinct cache key, so the 120s product-list
  // cache cannot make one case read another's result.
  const pub = (qs: string) =>
    request(app).get(`/api/v1/public/products${qs}`).set('x-store-id', storeId);
  const admin = (qs: string) => request(app).get(`/api/v1/stores/${storeId}/products${qs}`);

  describe('public storefront listing', () => {
    it('default listing (no featured param) returns BOTH products', async () => {
      const res = await pub('');
      expect(res.status).toBe(200);
      expect(names(res)).toEqual([FEATURED, PLAIN].sort());
    });

    it('a non-featured sort (price_asc) still returns BOTH products', async () => {
      const res = await pub('?sort=price_asc');
      expect(res.status).toBe(200);
      expect(names(res)).toEqual([FEATURED, PLAIN].sort());
    });

    it('featured=true returns only the featured product', async () => {
      const res = await pub('?featured=true');
      expect(res.status).toBe(200);
      expect(names(res)).toEqual([FEATURED]);
    });

    it('featured=false returns only the non-featured product', async () => {
      const res = await pub('?featured=false');
      expect(res.status).toBe(200);
      expect(names(res)).toEqual([PLAIN]);
    });

    it('a garbage featured value is rejected with 400', async () => {
      const res = await pub('?featured=yes');
      expect(res.status).toBe(400);
    });
  });

  describe('admin product list', () => {
    it('default list (no featured param) returns BOTH products', async () => {
      const res = await admin('');
      expect(res.status).toBe(200);
      expect(names(res)).toEqual([FEATURED, PLAIN].sort());
    });

    it('featured=true returns only the featured product', async () => {
      const res = await admin('?featured=true');
      expect(res.status).toBe(200);
      expect(names(res)).toEqual([FEATURED]);
    });

    it('featured=false returns only the non-featured product', async () => {
      const res = await admin('?featured=false');
      expect(res.status).toBe(200);
      expect(names(res)).toEqual([PLAIN]);
    });

    it('a garbage featured value is rejected with 400', async () => {
      const res = await admin('?featured=1');
      expect(res.status).toBe(400);
    });
  });

  describe('admin advanced search', () => {
    it('default search (no boolean params) returns BOTH products', async () => {
      const res = await admin(`/search?q=${encodeURIComponent(suffix)}`);
      expect(res.status).toBe(200);
      expect(names(res)).toEqual([FEATURED, PLAIN].sort());
    });

    it('featured=true returns only the featured product', async () => {
      const res = await admin(`/search?q=${encodeURIComponent(suffix)}&featured=true`);
      expect(res.status).toBe(200);
      expect(names(res)).toEqual([FEATURED]);
    });
  });
});
