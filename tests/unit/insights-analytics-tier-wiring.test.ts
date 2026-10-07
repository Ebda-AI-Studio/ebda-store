/**
 * Locked pricing: analytics tiers are enforced where the reports are served.
 * Which tier guards which insights route (requests are sent, the gate answers):
 *   standard (Growth+)  /insights/dashboard, /insights/products
 *   advanced (Business) /insights/cohorts, /funnel, /segments, /customers/rfm-batch, /customers/:id/rfm
 * The gate's own logic is proven in plan-gates.test.ts; here it is a recording stub that
 * REFUSES, so a route that lost its gate answers 200/500 instead of 402.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const seen = vi.hoisted(() => ({ tiers: [] as string[] }));

vi.mock('@force/database', () => ({
  prisma: {},
  runInTenantContext: (_s: string, fn: () => unknown) => fn(),
  RfmSegment: {},
}));
vi.mock('@api/middleware/auth', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 'u', role: 'store_admin' };
    next();
  },
  authorize: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/require-mfa', () => ({
  requireMfaEnrolled: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/store-access', () => ({
  requireStoreAccess: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('@api/middleware/analytics-tier', () => ({
  requireAnalyticsTier: (min: string) => (_req: any, res: any, _next: any) => {
    seen.tiers.push(min);
    res.status(402).json({ gated: min });
  },
}));
vi.mock('@api/services/accounting/insights-narration.service', () => ({
  generateInsightNarration: vi.fn(async () => null),
}));
vi.mock('@api/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const S = '11111111-1111-4111-8111-111111111111';
let app: Express;

beforeAll(async () => {
  const { default: router } = await import('@api/routes/insights.routes');
  app = express();
  app.use('/stores', router);
});

describe('insights routes carry their analytics tier gate', () => {
  it.each([
    [`/stores/${S}/insights/dashboard`, 'standard'],
    [`/stores/${S}/insights/products`, 'standard'],
    [`/stores/${S}/insights/cohorts`, 'advanced'],
    [`/stores/${S}/insights/funnel`, 'advanced'],
    [`/stores/${S}/insights/segments`, 'advanced'],
    [`/stores/${S}/insights/customers/rfm-batch`, 'advanced'],
    [`/stores/${S}/insights/customers/c1/rfm`, 'advanced'],
  ])('%s is gated at %s', async (path, tier) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(402);
    expect(res.body).toEqual({ gated: tier });
  });
});
