/**
 * The analytics page's period picker reaches every range-aware endpoint.
 *
 * 2026-09-30 audit, finding 8: the GL KPI cards were hard-coded to
 * month-to-date (they showed "this month" under "Last 90 days"), and the
 * cashflow route read `from`/`to` while the admin sent `startDate`/`endDate`,
 * so that chart was always the last 30 days. And `/sales` accepted any
 * `period` string and fell through to daily buckets.
 *
 * Mutation proof: in analytics.routes.ts pass `monthStart` back to
 * glRevenueWindow → the GL assertion goes red.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

const { svc } = vi.hoisted(() => ({
  svc: {
    getDashboardStats: vi.fn(async () => ({})),
    glRevenueWindow: vi.fn(async () => ({ revenue: 0, cogs: 0, grossProfit: 0, netIncome: 0 })),
    stockSnapshot: vi.fn(async () => ({})),
    cashflowTrend: vi.fn(async () => []),
    getSalesChart: vi.fn(async () => ({ sales: [], granularity: 'day' })),
    getPerformanceSummary: vi.fn(async () => ({})),
  },
}));

vi.mock('@ebda/database', () => ({ prisma: {} }));
vi.mock('@api/services/analytics.service', () => ({ AnalyticsService: svc }));
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

const START = '2026-07-02T21:00:00.000Z';
const END = '2026-09-30T20:59:59.999Z';
const QS = `startDate=${START}&endDate=${END}`;
let app: Express;

beforeAll(async () => {
  const { default: router } = await import('@api/routes/analytics.routes');
  app = express();
  app.use('/stores/:storeId/analytics', router);
});

beforeEach(() => {
  for (const fn of Object.values(svc)) fn.mockClear();
});

describe('analytics routes honour the period picker', () => {
  it('dashboard: the GL window is the selected range, not month-to-date', async () => {
    const res = await request(app).get(`/stores/s1/analytics/dashboard?${QS}`);
    expect(res.status).toBe(200);
    const [, from, to] = svc.glRevenueWindow.mock.calls[0] as unknown as [string, Date, Date];
    expect(from.toISOString()).toBe(START);
    expect(to.toISOString()).toBe(END);
  });

  // Issue 2256: a rejected sub-query is REPORTED in `failed`, so the page can
  // tell "did not load" from "zero sales" — the 200 alone cannot.
  it('dashboard: names the sub-queries that failed; an all-good dashboard reports none', async () => {
    svc.getDashboardStats.mockRejectedValueOnce(new Error('pool timeout'));
    const partial = await request(app).get(`/stores/s1/analytics/dashboard?${QS}`);
    expect(partial.status).toBe(200);
    expect(partial.body.data.stats).toBeNull();
    expect(partial.body.data.failed).toEqual(['stats']);

    const ok = await request(app).get(`/stores/s1/analytics/dashboard?${QS}`);
    expect(ok.body.data.failed).toEqual([]);
  });

  it('cashflow: reads startDate/endDate (the names the admin sends)', async () => {
    const res = await request(app).get(`/stores/s1/analytics/cashflow?${QS}`);
    expect(res.status).toBe(200);
    const [, from, to] = svc.cashflowTrend.mock.calls[0] as unknown as [string, Date, Date];
    expect(from.toISOString()).toBe(START);
    expect(to.toISOString()).toBe(END);
  });

  it('cashflow: an unparseable date is a 422, not a query on Invalid Date', async () => {
    const res = await request(app).get(`/stores/s1/analytics/cashflow?startDate=nope&endDate=x`);
    expect(res.status).toBe(422);
    expect(svc.cashflowTrend).not.toHaveBeenCalled();
  });

  it('sales: passes range + viewer tzOffset; returns granularity', async () => {
    const res = await request(app).get(
      `/stores/s1/analytics/sales?period=this_year&${QS}&tzOffset=180`
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sales: [], granularity: 'day' });
    const [, period, range, tz] = svc.getSalesChart.mock.calls[0] as unknown as [
      string,
      string,
      { startDate: Date; endDate: Date },
      number,
    ];
    expect(period).toBe('this_year');
    expect(range.startDate.toISOString()).toBe(START);
    expect(tz).toBe(180);
  });

  it('sales: an unknown period is a 422 (no silent fall-through to daily)', async () => {
    const res = await request(app).get(`/stores/s1/analytics/sales?period=fortnight&${QS}`);
    expect(res.status).toBe(422);
    expect(svc.getSalesChart).not.toHaveBeenCalled();
  });
});
