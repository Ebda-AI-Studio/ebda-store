/**
 * Admin low-stock report: "accepts backorder" is what the CART would do (W1b fix round 2),
 * driven through the real route instead of read off its source text:
 *   - the store's `inventory.backorder` feature off  -> false for every product;
 *   - feature on + the product's own flag            -> true;
 *   - feature on + an ACTIVE variant's flag          -> true;
 *   - feature on + only a DISABLED variant's flag    -> false (a disabled variant is not stock).
 *
 * Mutation proof: in analytics.routes.ts drop `backorderOn` (pass `true`) -> the feature-off
 * case goes red; drop `activeVariants(...)` (use `p.variants`) -> the disabled-variant case goes red.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const { svc, db, feature } = vi.hoisted(() => ({
  svc: { getLowStockProducts: vi.fn() },
  db: {
    backorderLine: { groupBy: vi.fn(async () => []) },
    reorderRule: { findMany: vi.fn(async () => []) },
    product: { findMany: vi.fn() },
  },
  feature: { on: false },
}));

vi.mock('@ebda/database', () => ({ prisma: db }));
vi.mock('@api/services/analytics.service', () => ({ AnalyticsService: svc }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: vi.fn(async () => feature.on) },
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/feature-gate', () => ({
  requireFeature: () => (_q: any, _s: any, n: any) => n(),
}));
vi.mock('@api/middleware/auth', () => ({
  rejectImpersonated: (_q: any, _s: any, n: any) => n(),
  authorize: () => (_q: any, _s: any, n: any) => n(),
  authenticate: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/rbac', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ROWS = [
  { id: 'own', allowBackorder: true, variants: [] },
  {
    id: 'active-variant',
    allowBackorder: false,
    variants: [{ allowBackorder: true, isActive: true }],
  },
  {
    id: 'disabled-variant',
    allowBackorder: false,
    variants: [
      { allowBackorder: true, isActive: false },
      { allowBackorder: false, isActive: true },
    ],
  },
  { id: 'none', allowBackorder: false, variants: [{ allowBackorder: false, isActive: true }] },
];

let app: Express;
beforeAll(async () => {
  const { default: router } = await import('@api/routes/analytics.routes');
  app = express();
  app.use('/stores/:storeId/analytics', router);
});

beforeEach(() => {
  svc.getLowStockProducts.mockResolvedValue(ROWS.map(r => ({ id: r.id, name: r.id })));
  db.product.findMany.mockResolvedValue(ROWS);
});

async function flags() {
  const res = await request(app).get('/stores/s1/analytics/low-stock');
  expect(res.status).toBe(200);
  return Object.fromEntries(
    (res.body.data.products as { id: string; acceptsBackorder: boolean }[]).map(p => [
      p.id,
      p.acceptsBackorder,
    ])
  );
}

describe('low-stock report: accepts backorder only when the cart would', () => {
  it('store feature off: no product accepts backorder, whatever its flags say', async () => {
    feature.on = false;
    expect(await flags()).toEqual({
      own: false,
      'active-variant': false,
      'disabled-variant': false,
      none: false,
    });
  });

  it('store feature on: the product flag or an ACTIVE variant flag, never a disabled one', async () => {
    feature.on = true;
    expect(await flags()).toEqual({
      own: true,
      'active-variant': true,
      'disabled-variant': false,
      none: false,
    });
  });
});
