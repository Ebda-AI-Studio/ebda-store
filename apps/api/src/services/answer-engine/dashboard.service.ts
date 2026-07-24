/**
 * Merchant-facing answer-engine dashboard aggregation (Task 7).
 *
 * Reads `AnswerEngineCheck` rows written by the weekly citation-scan cron
 * (`citation-scan.service.ts`) and turns them into the shape the admin
 * dashboard renders: per-engine cited counts, a week-over-week trend, the
 * latest per-prompt win/lose list (with competitor domains for losses), and
 * a "grounded caveat" flag.
 *
 * TENANT SCOPING: this module takes a `storeId` and queries
 * `prisma.answerEngineCheck` directly — same as every other read-only
 * analytics aggregator in this codebase (see `analytics.service.ts`). The
 * route that calls this is mounted behind `tenantContext` (RLS) AND
 * `requireStoreAccess`, so a viewer can only ever reach this function with
 * their own store's id — defense in depth, not the only gate.
 *
 * GROUNDED-CAVEAT PROXY: `AnswerEngineCheck` does not persist the raw
 * provider `EngineAnswer.grounded` flag (see `provider.ts` — it's an
 * in-memory-only signal consumed by `citation-scan.service.ts` at write
 * time, never written to a column). The best available proxy in the
 * persisted schema is `citedUrls` emptiness: a citation-scan run that
 * returned zero cited URLs for every one of an engine's latest prompts
 * produced no verifiable web citation to check against — either because
 * Gemini's grounding tool found nothing (fails safe to `grounded: false`,
 * see `gemini.provider.ts`) or because Perplexity/OpenAI returned an empty
 * response (Perplexity hardcodes `grounded: true` even then — the Task 4
 * minor finding this dashboard closes). Treating "every latest-per-prompt
 * check for this engine has an empty citedUrls array" as the caveat
 * condition directly implements that finding without a schema change.
 */
import { prisma, Prisma } from '@force/database';
import { getCachedAnalytics } from '../analytics.service';

export interface AnswerEngineSummary {
  engines: AnswerEngineSummaryEngine[];
  trend: AnswerEngineTrendPoint[];
  prompts: AnswerEngineSummaryPrompt[];
  lastRunAt: string | null;
}

export interface AnswerEngineSummaryEngine {
  engine: string;
  totalChecks: number;
  citedCount: number;
  citedRate: number;
  /** True when this engine's most recent run returned no verifiable web
   * citations for any prompt — see file header. Dashboard should surface
   * this as "based on model knowledge / unverified". */
  groundedCaveat: boolean;
}

export interface AnswerEngineTrendPoint {
  /** Monday (UTC) of the ISO week this bucket covers, `YYYY-MM-DD`. */
  weekStart: string;
  totalChecks: number;
  citedCount: number;
  citedRate: number;
}

export interface AnswerEngineSummaryPrompt {
  engine: string;
  promptText: string;
  locale: string;
  cited: boolean;
  rank: number | null;
  snippet: string | null;
  competitorUrls: string[];
  runAt: string;
}

// Bounds the query cost for a single-store read. The weekly cron writes at
// most ~8 prompts × (1 Gemini + up to 2 paid engines) = 24 rows/week/store,
// so 1000 rows covers roughly 8+ months of history — comfortably enough for
// the trend + latest-per-prompt views this endpoint serves.
const MAX_ROWS = 1000;

type CheckRow = {
  engine: string;
  promptText: string;
  locale: string;
  cited: boolean;
  rank: number | null;
  snippet: string | null;
  citedUrls: Prisma.JsonValue;
  competitorUrls: Prisma.JsonValue;
  runAt: Date;
};

function asStringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Monday-anchored (UTC) week-bucket key for a timestamp, so the trend is
 * stable regardless of the server's local timezone or exactly when in the
 * week the cron happened to run.
 */
function weekStartKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1) - day;
  date.setUTCDate(date.getUTCDate() + diff);
  return date.toISOString().slice(0, 10);
}

/**
 * Pure aggregation over already-fetched rows — split out from
 * `getAnswerEngineSummary` so it's unit-testable without a DB (tests build
 * `CheckRow[]` fixtures directly).
 */
export function aggregateAnswerEngineChecks(checks: CheckRow[]): AnswerEngineSummary {
  if (checks.length === 0) {
    return { engines: [], trend: [], prompts: [], lastRunAt: null };
  }

  // Rows arrive sorted `runAt desc`. Dedupe by engine+promptText, keeping
  // the FIRST (= most recent) occurrence — this is both the "latest run"
  // per-prompt win/lose set and the input to the grounded-caveat check.
  const seenPromptKeys = new Set<string>();
  const latestPerPrompt: CheckRow[] = [];
  for (const c of checks) {
    const key = `${c.engine}::${c.promptText}`;
    if (seenPromptKeys.has(key)) continue;
    seenPromptKeys.add(key);
    latestPerPrompt.push(c);
  }

  // Per-engine totals — across ALL fetched rows (not just latest-per-prompt),
  // so `citedRate` reflects real history, not just the most recent run.
  const engineTotals = new Map<string, { total: number; cited: number }>();
  for (const c of checks) {
    const entry = engineTotals.get(c.engine) ?? { total: 0, cited: 0 };
    entry.total += 1;
    if (c.cited) entry.cited += 1;
    engineTotals.set(c.engine, entry);
  }

  const engines: AnswerEngineSummaryEngine[] = Array.from(engineTotals.entries()).map(
    ([engine, totals]) => {
      const latestForEngine = latestPerPrompt.filter(c => c.engine === engine);
      const groundedCaveat =
        latestForEngine.length > 0 &&
        latestForEngine.every(c => asStringArray(c.citedUrls).length === 0);

      return {
        engine,
        totalChecks: totals.total,
        citedCount: totals.cited,
        citedRate: totals.total > 0 ? totals.cited / totals.total : 0,
        groundedCaveat,
      };
    }
  );

  // Week-over-week trend, combined across engines.
  const weekBuckets = new Map<string, { total: number; cited: number }>();
  for (const c of checks) {
    const key = weekStartKey(c.runAt);
    const entry = weekBuckets.get(key) ?? { total: 0, cited: 0 };
    entry.total += 1;
    if (c.cited) entry.cited += 1;
    weekBuckets.set(key, entry);
  }
  const trend: AnswerEngineTrendPoint[] = Array.from(weekBuckets.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([weekStart, totals]) => ({
      weekStart,
      totalChecks: totals.total,
      citedCount: totals.cited,
      citedRate: totals.total > 0 ? totals.cited / totals.total : 0,
    }));

  const prompts: AnswerEngineSummaryPrompt[] = latestPerPrompt.map(c => ({
    engine: c.engine,
    promptText: c.promptText,
    locale: c.locale,
    cited: c.cited,
    rank: c.rank ?? null,
    snippet: c.snippet ?? null,
    competitorUrls: asStringArray(c.competitorUrls),
    runAt: c.runAt.toISOString(),
  }));

  return {
    engines,
    trend,
    prompts,
    lastRunAt: checks[0].runAt.toISOString(),
  };
}

async function computeAnswerEngineSummary(storeId: string): Promise<AnswerEngineSummary> {
  const checks = await prisma.answerEngineCheck.findMany({
    where: { storeId },
    orderBy: { runAt: 'desc' },
    take: MAX_ROWS,
    select: {
      engine: true,
      promptText: true,
      locale: true,
      cited: true,
      rank: true,
      snippet: true,
      citedUrls: true,
      competitorUrls: true,
      runAt: true,
    },
  });

  return aggregateAnswerEngineChecks(checks);
}

/**
 * Cache-aside read (>=120s TTL per the analytics pattern) — the underlying
 * data only changes once a week (the citation-scan cron), so a 300s TTL is
 * comfortably fresh without hammering Neon on every dashboard load.
 */
export async function getAnswerEngineSummary(storeId: string): Promise<AnswerEngineSummary> {
  return getCachedAnalytics(`answer-engine:summary:${storeId}`, 300, () =>
    computeAnswerEngineSummary(storeId)
  );
}
