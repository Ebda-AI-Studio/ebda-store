/**
 * GET /insights/products and GET /insights/dashboard against real Postgres.
 *
 * The unit contract test (tests/unit/insights-routes-contract.test.ts) mocks
 * Prisma, so it cannot prove the grouped queries themselves run: the two-key
 * groupBy ordering, the 7d/30d windows, the variant-aware stock select. This
 * mounts the real router (auth chain stubbed) on the integration database and
 * parses the response with the shared schema the admin page is typed from.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { prisma } from '@ebda/database';
import { planService } from '../../apps/api/src/services/plan.service';
import { productVelocityResponseSchema } from '../../packages/shared/src/schemas/analytics';

vi.mock('@api/middleware/auth', () => ({
  rejectImpersonated: (_q: any, _s: any, n: any) => n(),
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'admin-1', role: 'store_admin' };
    next();
  },
  authorize:
    (..._roles: string[]) =>
    (_req: any, _res: any, next: any) =>
      next(),
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/services/accounting/insights-narration.service', () => ({
  generateInsightNarration: vi.fn(async () => null),
}));

const OWNER = '00000000-0000-0000-0000-0000000009a3';
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const DAY = 24 * 60 * 60 * 1000;
let storeId: string;
let variantProductId: string;
let simpleProductId: string;
let app: Express;

async function paidOrder(daysAgo: number, lines: Array<[string, number, number]>, email: string) {
  await prisma.order.create({
    data: {
      storeId,
      orderNumber: `VEL-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
      status: 'confirmed',
      paymentStatus: 'paid',
      subtotal: 0,
      tax: 0,
      shipping: 0,
      discount: 0,
      total: lines.reduce((s, [, q, p]) => s + q * p, 0),
      currency: 'EGP',
      shippingAddress: { email, phone: '' },
      billingAddress: {},
      createdAt: new Date(Date.now() - daysAgo * DAY),
      items: {
        create: lines.map(([productId, quantity, price]) => ({
          productId,
          productName: 'x',
          quantity,
          price,
          total: quantity * price,
        })),
      },
    },
  });
}

beforeAll(async () => {
  await prisma.user.upsert({
    where: { id: OWNER },
    update: {},
    create: {
      id: OWNER,
      email: `velocity-${suffix}@x.test`,
      passwordHash: 'x',
      firstName: 'V',
      lastName: 'L',
    },
  });
  const s = await prisma.store.create({
    data: { name: `velocity-${suffix}`, slug: `velocity-${suffix}`, ownerId: OWNER },
  });
  storeId = s.id;
  // Locked pricing: product velocity is the `standard` and funnel the `advanced` analytics tier (Business); a default (Basic) store gets 402.
  await planService.assignPlan(storeId, { planCode: 'business' });

  const variant = await prisma.product.create({
    data: {
      storeId,
      name: 'Variant',
      slug: `variant-${suffix}`,
      price: 1000,
      costPrice: 400,
      inventory: 0, // unused for a variant product
      variants: {
        create: [
          { title: 'A', sku: `A-${suffix}`, inventory: 5, isActive: true },
          { title: 'B', sku: `B-${suffix}`, inventory: 100, isActive: false },
        ],
      },
    },
  });
  variantProductId = variant.id;
  const simple = await prisma.product.create({
    data: { storeId, name: 'Simple', slug: `simple-${suffix}`, price: 2000, inventory: 9 },
  });
  simpleProductId = simple.id;

  // Variant: 4 units 2 days ago + 6 units 20 days ago → 7d=4, 30d=10.
  await paidOrder(2, [[variantProductId, 4, 1000]], 'guest@x.com');
  await paidOrder(20, [[variantProductId, 6, 1000]], 'guest@x.com');
  // Simple: 3 units 10 days ago; and 50 units 200 days ago (outside 30d).
  await paidOrder(10, [[simpleProductId, 3, 2000]], 'other@x.com');
  await paidOrder(200, [[simpleProductId, 50, 2000]], 'old@x.com');

  const { default: router } = await import('@api/routes/insights.routes');
  app = express();
  app.use(express.json());
  app.use('/stores', router);
});

afterAll(async () => {
  await prisma.orderItem.deleteMany({ where: { order: { storeId } } });
  await prisma.order.deleteMany({ where: { storeId } });
  await prisma.productVariant.deleteMany({ where: { product: { storeId } } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
});

describe('insights routes on Postgres', () => {
  it('products: 30d ranking, 7d/30d units, variant-aware stock, shared schema', async () => {
    const res = await request(app).get(`/stores/${storeId}/insights/products?perPage=50`);
    expect(res.status).toBe(200);
    const body = productVelocityResponseSchema.parse(res.body.data);
    expect(body.products.map(p => p.productId)).toEqual([variantProductId, simpleProductId]);
    expect(body.products[0]).toMatchObject({
      rank: 1,
      unitsSold7d: 4,
      unitsSold30d: 10,
      velocityPerDay: 10 / 30,
      avgSellingPriceFils: 1000,
      stockOnHand: 5, // disabled variant's 100 is not stock
      costPriceFils: 400,
    });
    expect(body.products[1]).toMatchObject({
      unitsSold7d: 0,
      unitsSold30d: 3,
      stockOnHand: 9,
      costPriceFils: null,
    });
  });

  it('dashboard: guest buyers counted by contact → repeat rate is a real fraction', async () => {
    const res = await request(app).get(`/stores/${storeId}/insights/dashboard`);
    expect(res.status).toBe(200);
    // Last 30d: guest@x.com ordered twice, other@x.com once → 1/2.
    expect(res.body.data.repeatPurchaseRate).toBe(0.5);
    expect(res.body.data.repeatPurchaseBuyers).toBe(2);
    // Every fixture order is a guest order → funnel checkouts are not tracked.
    expect(res.body.data.guestCheckout).toBe(true);
  });

  it('funnel: guestCheckout from a real guest-order probe', async () => {
    const res = await request(app).get(`/stores/${storeId}/insights/funnel?window=30`);
    expect(res.status).toBe(200);
    expect(res.body.data.guestCheckout).toBe(true);
    expect(Array.isArray(res.body.data.days)).toBe(true);
  });
});
