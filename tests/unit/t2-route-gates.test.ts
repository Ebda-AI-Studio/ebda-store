/**
 * Admin fix pass T2 (BE:S-5, S-6, S-29/D7, S-27, S-24, F-6): the plan gates exist on the routes the UI gates, and the request
 * schemas bound what the audit found unbounded. The routers are loaded for real with the middleware factories replaced by
 * recorders, so the assertion is on the actual chain of each route.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: (key: string) =>
    Object.assign((_q: any, _s: any, n: any) => n(), { featureKey: key }),
}));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (_q: any, _s: any, n: any) => n(),
  optionalAuthenticate: (_q: any, _s: any, n: any) => n(),
  rejectImpersonated: (_q: any, _s: any, n: any) => n(),
  authorize: () => (_q: any, _s: any, n: any) => n(),
  customerUserId: () => undefined,
  getAuthUser: () => ({}),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_q: any, _s: any, n: any) => n(),
  checkStoreAccess: () => true,
}));
vi.mock('@api/middleware/tenant-context', () => ({
  tenantContext: (_q: any, _s: any, n: any) => n(),
  storeScopeContext: (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/rbac', () => ({
  requirePermission: () => (_q: any, _s: any, n: any) => n(),
  hasPermission: () => true,
}));
vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<object>()),
  prisma: {},
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: vi.fn(),
  storeWriter: vi.fn(),
  storeRepo: vi.fn(),
}));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

type Layer = {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: any }> };
};
function chainOf(router: any, method: string, path: string): string[] {
  const layer = (router.stack as Layer[]).find(
    l => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer?.route) throw new Error(`no ${method} ${path}`);
  return layer.route.stack.map(s => s.handle.featureKey as string).filter(Boolean);
}

describe('server-side plan gates (D7)', () => {
  it('newsletter broadcast needs email_campaigns (BE:S-5)', async () => {
    const router = (await import('@api/routes/newsletter.routes')).default;
    expect(chainOf(router, 'post', '/:storeId/newsletter/broadcast')).toContain('email_campaigns');
  });

  it('every catalog-import route needs bulk_operations (BE:S-6)', async () => {
    const router: any = (await import('@api/routes/catalog-import.routes')).default;
    const routes = (router.stack as Layer[]).filter(l => l.route);
    expect(routes.length).toBeGreaterThan(3);
    for (const l of routes)
      expect(
        l.route!.stack.map(s => s.handle.featureKey).filter(Boolean),
        `${Object.keys(l.route!.methods)} ${l.route!.path}`
      ).toContain('bulk_operations');
  });

  it('wholesale list and reject are gated; revoke stays open (BE:S-29)', async () => {
    const router = (await import('@api/routes/wholesale.routes')).merchantWholesaleRouter;
    const base = '/:storeId/wholesale-applications';
    expect(chainOf(router, 'get', base)).toContain('b2b.wholesale');
    expect(chainOf(router, 'post', `${base}/:id/reject`)).toContain('b2b.wholesale');
    expect(chainOf(router, 'post', `${base}/:id/revoke`)).not.toContain('b2b.wholesale');
  });

  it('coupon validate needs coupons; loyalty join and my-transactions need loyalty (BE:S-29)', async () => {
    const coupons = (await import('@api/routes/coupon.routes')).default;
    expect(chainOf(coupons, 'post', '/public/:storeId/coupons/validate')).toContain('coupons');
    const { publicLoyaltyRoutes } = await import('@api/routes/loyalty.routes');
    expect(chainOf(publicLoyaltyRoutes, 'post', '/:storeId/loyalty/join')).toContain('loyalty');
    expect(chainOf(publicLoyaltyRoutes, 'get', '/:storeId/loyalty/my-transactions')).toContain(
      'loyalty'
    );
  });
});

describe('request schemas', () => {
  it('a manual loyalty award is a non-zero whole number within 100 000 (BE:S-27)', async () => {
    const { awardPointsSchema } = await import('@api/routes/loyalty.routes');
    const ok = (points: number) =>
      awardPointsSchema.safeParse({ points, type: 'earn_manual' }).success;
    expect(ok(50)).toBe(true);
    expect(ok(-100_000)).toBe(true);
    expect(ok(0)).toBe(false);
    expect(ok(100_001)).toBe(false);
    expect(ok(-100_001)).toBe(false);
    expect(ok(2.5)).toBe(false);
  });

  it('a percentage coupon is a whole percent from 1 to 100 (BE:S-24)', async () => {
    const { createCouponSchema, updateCouponSchema } = await import('@api/routes/coupon.routes');
    const make = (type: string, value: number) =>
      createCouponSchema.safeParse({ code: 'x', name: 'n', type, value }).success;
    expect(make('percentage', 100)).toBe(true);
    expect(make('percentage', 1)).toBe(true);
    expect(make('percentage', 101)).toBe(false);
    expect(make('percentage', 12.5)).toBe(false);
    expect(make('percentage', 0)).toBe(false);
    expect(make('fixed', 5000)).toBe(true);
    expect(updateCouponSchema.safeParse({ type: 'percentage', value: 150 }).success).toBe(false);
    expect(updateCouponSchema.safeParse({ name: 'only a name' }).success).toBe(true);
  });

  it('product create accepts a single image or images[], category create accepts images[] (BE:F-6)', async () => {
    const { createProductSchemaChecked } = await import('@api/routes/product.routes');
    const base = { name: 'P', price: 1000 };
    const one = createProductSchemaChecked.parse({
      ...base,
      image: 'https://cdn.example.test/a.png',
    });
    expect(one.images).toEqual([{ url: 'https://cdn.example.test/a.png' }]);
    expect('image' in one).toBe(false);
    const both = createProductSchemaChecked.parse({
      ...base,
      image: 'https://cdn.example.test/a.png',
      images: [{ url: 'https://cdn.example.test/b.png' }],
    });
    expect(both.images).toEqual([{ url: 'https://cdn.example.test/b.png' }]);
    const { createCategorySchema } = await import('@api/routes/category.routes');
    const cat = createCategorySchema.parse({
      name: 'C',
      images: [{ url: 'https://cdn.example.test/c.png' }],
    });
    expect(cat.images?.[0].url).toBe('https://cdn.example.test/c.png');
  });
});
