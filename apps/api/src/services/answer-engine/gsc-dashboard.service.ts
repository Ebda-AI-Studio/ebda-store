/**
 * Merchant-facing Google Search Console dashboard read API (Plan 8B, Task 4).
 *
 * Reads `GscDailyMetric` rows written by the daily GSC ingestion cron
 * (`gsc-ingest.service.ts`, Task 3) and turns them into the shape the
 * answer-engine dashboard renders: a recent daily trend
 * (impressions/clicks/ctr/position), aggregate totals over that window, and
 * the latest row's top queries.
 *
 * TENANT SCOPING: this module takes a `storeId` and queries
 * `prisma.gscDailyMetric` directly, same pattern as
 * `dashboard.service.ts`'s `getAnswerEngineSummary` — the route that calls
 * this is mounted behind `tenantContext` (RLS) AND `requireStoreAccess`, so
 * a viewer can only ever reach this function with their own store's id.
 *
 * NOT-CONNECTED vs GENUINE ZERO (Task-3 reviewer note): GSC ingestion is
 * dormant until `GSC_SERVICE_ACCOUNT_JSON` is set (see docs/ENVIRONMENT.md),
 * and even once live, a store's `runGscIngest` skips writing any row at all
 * when the service account has no access to the property
 * (`skipped: 'no_access'`) or the store has no domain (`skipped: 'no_domain'`).
 * In every one of those cases there are ZERO `GscDailyMetric` rows for the
 * store — indistinguishable, at the DB level, from "the property genuinely
 * had zero impressions every day". Rather than render a misleading all-zero
 * chart, `hasData`/`connected` is `false` whenever there are no rows at all,
 * and the UI renders a "Google Search Console not connected" empty state
 * instead of a chart.
 */
import { analyticsRead } from '../../lib/analytics-backend';
import { prisma } from '@ebda/database';
import { getCachedAnalytics } from '../analytics.service';

export interface GscTrendPoint {
  /** `YYYY-MM-DD`. */
  date: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
}

export interface GscTopQuery {
  query: string;
  impressions: number;
  clicks: number;
}

export interface GscDashboardTotals {
  impressions: number;
  clicks: number;
  /** Aggregate CTR over the window — clicks/impressions, NOT an average of
   * the per-day ctr values (which would over-weight low-traffic days). */
  ctr: number;
  /** Impression-weighted average position over the window — a day with
   * more impressions counts more toward the average, matching how GSC
   * itself presents the "Average position" metric over a date range. */
  avgPosition: number;
}

export interface GscDashboard {
  /** False when there are ZERO `GscDailyMetric` rows for this store — see
   * file header. Mirrors `hasData`; both are provided so the UI can key off
   * whichever reads more naturally at the call site. */
  connected: boolean;
  hasData: boolean;
  /** Ascending by date (oldest first) — ready to feed straight into a trend
   * chart left-to-right. */
  trend: GscTrendPoint[];
  totals: GscDashboardTotals | null;
  topQueries: GscTopQuery[];
  lastUpdatedAt: string | null;
}

// Bounds the query cost for a single-store read. The daily cron writes at
// most one row/day/store, so 180 rows covers roughly 6 months of history —
// comfortably enough for the trend this endpoint serves.
const MAX_ROWS = 180;

function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function asTopQueries(value: unknown): GscTopQuery[] {
  if (!Array.isArray(value)) return [];
  const out: GscTopQuery[] = [];
  for (const entry of value) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as Record<string, unknown>).query === 'string'
    ) {
      const e = entry as Record<string, unknown>;
      out.push({
        query: e.query as string,
        impressions: typeof e.impressions === 'number' ? e.impressions : 0,
        clicks: typeof e.clicks === 'number' ? e.clicks : 0,
      });
    }
  }
  return out;
}

const EMPTY_DASHBOARD: GscDashboard = {
  connected: false,
  hasData: false,
  trend: [],
  totals: null,
  topQueries: [],
  lastUpdatedAt: null,
};

async function computeGscDashboard(storeId: string): Promise<GscDashboard> {
  // Fetched date-desc (latest first) so `rows[0]` is the latest row without
  // a second query — reversed below to build the ascending trend.
  const findArgs = {
    where: { storeId },
    orderBy: { date: 'desc' as const },
    take: MAX_ROWS,
    select: {
      date: true,
      impressions: true,
      clicks: true,
      ctr: true,
      position: true,
      topQueries: true,
      updatedAt: true,
    },
  };
  // Ruling NZ-AN-1: the store's DO once its analytics moved, else Postgres
  const rows = await analyticsRead(
    storeId,
    r => r.gscDailyMetric.findMany(findArgs),
    () => prisma.gscDailyMetric.findMany(findArgs)
  );

  if (rows.length === 0) {
    return EMPTY_DASHBOARD;
  }

  const trend: GscTrendPoint[] = rows
    .slice()
    .reverse()
    .map(r => ({
      date: toYmd(r.date),
      impressions: r.impressions,
      clicks: r.clicks,
      ctr: r.ctr,
      position: r.position,
    }));

  let totalImpressions = 0;
  let totalClicks = 0;
  let positionWeightedSum = 0;
  for (const r of rows) {
    totalImpressions += r.impressions;
    totalClicks += r.clicks;
    positionWeightedSum += r.position * r.impressions;
  }
  const totals: GscDashboardTotals = {
    impressions: totalImpressions,
    clicks: totalClicks,
    ctr: totalImpressions > 0 ? totalClicks / totalImpressions : 0,
    avgPosition: totalImpressions > 0 ? positionWeightedSum / totalImpressions : 0,
  };

  const latest = rows[0];

  return {
    connected: true,
    hasData: true,
    trend,
    totals,
    topQueries: asTopQueries(latest.topQueries),
    lastUpdatedAt: latest.updatedAt.toISOString(),
  };
}

/**
 * Cache-aside read (>=120s TTL per the analytics/answer-engine pattern) —
 * the underlying data only changes once a day (the GSC ingestion cron), so
 * a 300s TTL is comfortably fresh without hammering Neon on every dashboard
 * load.
 */
export async function getGscDashboard(storeId: string): Promise<GscDashboard> {
  return getCachedAnalytics(`answer-engine:gsc:${storeId}`, 300, () =>
    computeGscDashboard(storeId)
  );
}
