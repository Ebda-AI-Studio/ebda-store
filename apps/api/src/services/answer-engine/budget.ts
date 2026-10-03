/**
 * Per-engine daily spend cap for the PAID answer-engine providers
 * (perplexity/openai) — closes the Task 4 deferral that those adapters had
 * no budget guard of their own.
 *
 * Gemini is NOT covered here — it already goes through the platform-wide
 * `assertAiQuota()` inside `gemini.provider.ts`'s `query()`, which is a
 * shared daily/monthly request cap across every store and engine. Paid
 * engines need a SEPARATE bound because they're opt-in, billed directly to
 * Ebda (not covered by the Gemini free-tier accounting), and each has
 * its own account-level rate/spend limits.
 *
 * Reuses the existing `aiUsage` table rather than adding a new one: the
 * citation-scan orchestrator calls `recordUsage(storeId, 'answer_engine_
 * <engine>', 0, 0, false)` after every successful paid-engine call (see
 * citation-scan.service.ts), and this module counts today's rows for that
 * feature key across ALL stores — a platform-wide cap, matching how
 * `assertAiQuota()` counts Gemini calls across all stores/features.
 *
 * PLATFORM-WIDE VIA RLS BYPASS (money-path fix, 2026-07-22): the cron calls
 * `runCitationScan` INSIDE `runInTenantContext(store.id)`, so the exported
 * `prisma` proxy here would otherwise route the count through the store's
 * tenant transaction — and the `ai_usage` RLS policy filters
 * `store_id = current_setting('app.current_store_id')`, collapsing this
 * "platform-wide" count to ONE store's rows. That silently turned the cap
 * per-store (weekly cron ~8 rows/store never trips a 200/day cap; aggregate
 * spend becomes cap × store-count, unbounded). Counting via `withRlsBypass`
 * makes the query ignore the tenant GUC entirely, so it always aggregates
 * across every store regardless of which (if any) tenant context it runs
 * inside — matching the doc comment above and `assertAiQuota()`'s semantics.
 */
import { withRlsBypass } from '@force/database';
import logger from '../../lib/logger';

const DEFAULT_PAID_ENGINE_DAILY_CAP = 200;

function capEnvVarName(engine: string): string {
  return `ANSWER_ENGINE_${engine.toUpperCase()}_DAILY_CAP`;
}

function getDailyCap(engine: string): number {
  const raw = process.env[capEnvVarName(engine)];
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PAID_ENGINE_DAILY_CAP;
}

/**
 * True when a paid engine (perplexity/openai) has already reached its daily
 * cap and MUST be skipped for the rest of today's runs. Never throws — a
 * count-query failure degrades to "not over budget" (logged) rather than
 * throwing, since the citation scan's fail-soft contract means a budget
 * CHECK failure must not itself abort the store's scan; the actual spend
 * guard is the cap comparison, not this defensive fallback.
 */
export async function isPaidEngineOverBudget(engine: string): Promise<boolean> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  try {
    const count = await withRlsBypass(tx =>
      tx.aiUsage.count({
        where: {
          feature: `answer_engine_${engine}`,
          createdAt: { gte: startOfDay },
        },
      })
    );

    return count >= getDailyCap(engine);
  } catch (err) {
    logger.warn({ err, engine }, 'answer-engine budget check failed; treating as under budget');
    return false;
  }
}
