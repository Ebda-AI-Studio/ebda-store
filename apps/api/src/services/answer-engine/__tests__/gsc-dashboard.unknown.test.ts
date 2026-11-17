import { describe, it, expect, vi, beforeEach } from 'vitest';

const { rows } = vi.hoisted(() => ({ rows: { value: [] as unknown[] } }));
vi.mock('../../../lib/analytics-backend', () => ({
  analyticsRead: async () => rows.value,
}));
vi.mock('@ebda/database', () => ({ prisma: {} }));
vi.mock('../../analytics.service', () => ({
  getCachedAnalytics: (_k: string, _ttl: number, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../../../lib/repo-factory', () => ({ storeDb: async () => ({}) }));
vi.mock('../gsc-client', () => ({
  isGscConfigured: () => true,
  listAccessibleGscSites: async () => [],
  pickGscTarget: () => null,
}));

import { getGscDashboard } from '../gsc-dashboard.service';

const day = (date: string, impressions: number, clicks: number, ctr: number, position: number) => ({
  date: new Date(`${date}T00:00:00Z`),
  impressions,
  clicks,
  ctr,
  position,
  topQueries: [],
  updatedAt: new Date('2026-07-21T00:00:00Z'),
});

beforeEach(() => {
  rows.value = [];
});

describe('GSC dashboard: unknown is not zero', () => {
  it('a window with no impressions has null ctr and avgPosition, not 0', async () => {
    rows.value = [day('2026-07-20', 0, 0, 0, 0), day('2026-07-19', 0, 0, 0, 0)];
    const out = await getGscDashboard('store-zero');
    expect(out.totals).toMatchObject({ impressions: 0, clicks: 0, ctr: null, avgPosition: null });
    expect(out.trend.every(p => p.ctr === null && p.position === null)).toBe(true);
  });

  it('a window with impressions keeps real figures; only the zero-impression day is null', async () => {
    rows.value = [day('2026-07-20', 200, 20, 0.1, 4), day('2026-07-19', 0, 0, 0, 0)];
    const out = await getGscDashboard('store-mixed');
    expect(out.totals?.ctr).toBeCloseTo(0.1);
    expect(out.totals?.avgPosition).toBeCloseTo(4);
    const byDate = Object.fromEntries(out.trend.map(p => [p.date, p]));
    expect(byDate['2026-07-20']).toMatchObject({ ctr: 0.1, position: 4 });
    expect(byDate['2026-07-19']).toMatchObject({ ctr: null, position: null });
  });
});
