/**
 * AI usage reads that used to be raw SQL (Ruling NZ-AN-1). `ai_usage` is ONE platform table: on D1 once the `ai-usage` family
 * marker exists (services/platform/cutover.ts), in Postgres before. Every function here goes through `prisma.aiUsage.*`, which
 * the model router answers from D1 or Postgres, so one body serves both and no raw `ai_usage` SQL is left in the API.
 * Tenant scoping on the Postgres side is the caller's ambient store scope, as for any `prisma.aiUsage` call.
 */
import { prisma } from '@ebda/database';

export interface AiUsageTotals {
  calls: number;
  billableCalls: number;
  tokensIn: number;
  tokensOut: number;
  costMicros: number;
  unpricedCalls: number;
}

/** One store's AI usage in [start, end): the monthly usage snapshot's AI columns. */
export async function aiUsageTotals(
  storeId: string,
  start: Date,
  end: Date
): Promise<AiUsageTotals> {
  const window = { storeId, createdAt: { gte: start, lt: end } };
  const [calls, billable, sums, unpriced] = await Promise.all([
    prisma.aiUsage.count({ where: window }),
    prisma.aiUsage.count({ where: { ...window, cachedHit: false } }),
    prisma.aiUsage.aggregate({
      where: window,
      _sum: { inputTokens: true, outputTokens: true, costMicros: true },
    }),
    prisma.aiUsage.count({ where: { ...window, cachedHit: false, costMicros: null } }),
  ]);
  return {
    calls,
    billableCalls: billable,
    tokensIn: sums._sum.inputTokens ?? 0,
    tokensOut: sums._sum.outputTokens ?? 0,
    costMicros: sums._sum.costMicros ?? 0,
    unpricedCalls: unpriced,
  };
}

/** Spend (micros) and the number of unpriced rows since `since`: NULL cost is "no rate configured", never folded into 0. */
export async function aiUsageCost(
  storeId: string,
  since: Date
): Promise<{ total: number | null; unpriced: number }> {
  const [sum, unpriced] = await Promise.all([
    prisma.aiUsage.aggregate({
      where: { storeId, createdAt: { gte: since } },
      _sum: { costMicros: true },
    }),
    prisma.aiUsage.count({ where: { storeId, createdAt: { gte: since }, costMicros: null } }),
  ]);
  return { total: sum._sum.costMicros ?? null, unpriced };
}

/** Calls per UTC day over the last 30 days, ascending (the old `DATE_TRUNC('day', created_at)` group, bucketed here). */
export async function aiUsageLast30Days(
  storeId: string,
  now: Date = new Date()
): Promise<Array<{ day: string; total: number }>> {
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const rows = await prisma.aiUsage.findMany({
    where: { storeId, createdAt: { gte: since } },
    select: { createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const day = r.createdAt.toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  return [...byDay].map(([day, total]) => ({ day, total }));
}

export interface AiUsageFeatureStat {
  feature: string;
  featureCount: number;
  lastCallAt: Date | null;
  todayCount: number;
  monthCount: number;
  monthCostMicros: number;
  monthUnpriced: number;
}

/** One store's per-feature usage for the super-admin AI dashboard (what the raw `GROUP BY store_id, feature` returned). */
export async function aiUsageFeatureStats(
  storeId: string,
  startOfDay: Date,
  startOfMonth: Date
): Promise<AiUsageFeatureStat[]> {
  const [all, today, month, cost, unpriced] = await Promise.all([
    prisma.aiUsage.groupBy({
      by: ['feature'],
      where: { storeId },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    prisma.aiUsage.groupBy({
      by: ['feature'],
      where: { storeId, createdAt: { gte: startOfDay }, cachedHit: false },
      _count: { _all: true },
    }),
    prisma.aiUsage.groupBy({
      by: ['feature'],
      where: { storeId, createdAt: { gte: startOfMonth }, cachedHit: false },
      _count: { _all: true },
    }),
    prisma.aiUsage.groupBy({
      by: ['feature'],
      where: { storeId, createdAt: { gte: startOfMonth } },
      _sum: { costMicros: true },
    }),
    prisma.aiUsage.groupBy({
      by: ['feature'],
      where: { storeId, createdAt: { gte: startOfMonth }, cachedHit: false, costMicros: null },
      _count: { _all: true },
    }),
  ]);
  const n = (rows: Array<{ feature: string; _count?: { _all: number } }>) =>
    new Map(rows.map(r => [r.feature, r._count?._all ?? 0]));
  const todayBy = n(today);
  const monthBy = n(month);
  const unpricedBy = n(unpriced);
  const costBy = new Map(cost.map(r => [r.feature, r._sum.costMicros ?? 0]));
  return all.map(r => ({
    feature: r.feature,
    featureCount: r._count._all,
    lastCallAt: r._max.createdAt,
    todayCount: todayBy.get(r.feature) ?? 0,
    monthCount: monthBy.get(r.feature) ?? 0,
    monthCostMicros: costBy.get(r.feature) ?? 0,
    monthUnpriced: unpricedBy.get(r.feature) ?? 0,
  }));
}
