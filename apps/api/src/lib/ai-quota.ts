import { resolveAiCaps } from './usage-caps';
import { prisma } from '@ebda/database';
import { countAiUsage } from './definer';
import { AppError } from '../middleware/error-handler';
import { AI_DISABLED_BY_MERCHANT_CODE, assertStoreAiEnabled } from './store-ai-switch';
import { assertStoreAiPlan } from './ai-plan-gate';

export const AI_QUOTA_DAILY_CODE = 'AI_QUOTA_DAILY_EXCEEDED';
export const AI_QUOTA_MONTHLY_CODE = 'AI_QUOTA_MONTHLY_EXCEEDED';
export const AI_QUOTA_STORE_DAILY_CODE = 'AI_QUOTA_STORE_DAILY_EXCEEDED';

function errCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * PLATFORM caps only — our own deterministic per-account daily/monthly request
 * caps (assertAiQuota). These are terminal: retrying within the window is futile.
 * `callWithRetry` uses THIS (not the broad predicate below) so a transient Gemini
 * per-minute 429 still gets retried with backoff and can recover.
 */
export function isPlatformQuotaCap(err: unknown): boolean {
  const code = errCode(err);
  return (
    code === AI_QUOTA_DAILY_CODE ||
    code === AI_QUOTA_MONTHLY_CODE ||
    code === AI_QUOTA_STORE_DAILY_CODE
  );
}

// Codes that mean "AI budget/quota is exhausted — STOP the sweep, don't keep
// trying every remaining product". Broader than isPlatformQuotaCap — it also
// includes the Gemini-wrapped 429 + per-store budget, because by the time a bulk
// loop catches one of these the retry wrapper (if any) has already exhausted its
// attempts, so continuing the sweep just burns the rest of the catalogue:
//  - AI_QUOTA_DAILY/MONTHLY_EXCEEDED → platform request caps (assertAiQuota)
//  - AI_QUOTA_EXCEEDED              → a Gemini 429 wrapped by ai.service.ts rethrowAsAppError
//  - AI_BUDGET_EXCEEDED            → per-store daily token budget (ai.service.ts checkBudget)
// Before this caught the latter two, a Gemini 429 mid-sweep was treated as a
// per-product failure and the loop kept calling Gemini for every remaining
// product → dozens of identical "AI quota reached" failures instead of one stop.
// NOTE: keep this OUT of the retry-transient check (use isPlatformQuotaCap there)
// — lumping AI_QUOTA_EXCEEDED in would make callWithRetry stop retrying recoverable
// per-minute throttles.
const AI_QUOTA_STOP_CODES = new Set([
  AI_QUOTA_DAILY_CODE,
  AI_QUOTA_MONTHLY_CODE,
  AI_QUOTA_STORE_DAILY_CODE,
  // the merchant turned AI off: a sweep must stop, not fail every remaining product
  AI_DISABLED_BY_MERCHANT_CODE,
  // the store has no paid plan (ai-plan-gate.ts; a literal, not an import: many tests mock that module)
  'AI_PLAN_REQUIRED',
  'AI_QUOTA_EXCEEDED',
  'AI_BUDGET_EXCEEDED',
]);

export function isAiQuotaCapError(err: unknown): boolean {
  const code = errCode(err);
  return code !== null && AI_QUOTA_STOP_CODES.has(code);
}

// Global cap on Gemini calls per day / per month, shared across all
// stores on this account. Protects the free-tier quota from a single
// bulk sweep blowing through it for the rest of the day. Only counts
// non-cached calls — cache hits never touch Gemini.
//
// Caps live in ./usage-caps (Ruling PLANS-1: 1800/day + 54000/month platform-wide); the routes read them from there too.

/**
 * Enforce the platform AI request caps BEFORE spending a Gemini call.
 *
 * Layers (checked in order):
 *  1. per-store daily slice — `storeId` callers are bounded to their own
 *     share so a single tenant cannot exhaust the platform budget;
 *  2. global daily cap — KEPT: it protects the real Google project ceiling
 *     (2 Gemini projects, ~2000 req/day free tier). `bulk: true` callers (background sweeps)
 *     stop an interactive-reserve below it (AI_DAILY_INTERACTIVE_RESERVE,
 *     default 20% of the daily cap) so a sweep can never zero out the
 *     interactive features (translate button, palette, answer-engine) for
 *     the whole platform;
 *  3. global monthly cap.
 *
 * Callers SHOULD pass their storeId; a no-arg call still enforces the
 * global caps (backward compatible).
 */
export async function assertAiQuota(
  opts: { storeId?: string; bulk?: boolean } = {}
): Promise<void> {
  // The merchant's own switch comes first: off means no AI spend at all for this store.
  if (opts.storeId) {
    await assertStoreAiEnabled(opts.storeId);
    // Then the entitlement (Ruling AI-PLAN-GATE-1): no paid plan, no AI spend, checked before any usage count.
    await assertStoreAiPlan(opts.storeId);
  }

  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  // The two PLATFORM counts are cross-store questions, so they go through the
  // `ebda_ai_usage_count` definer (issue 2040 / issue 2043): `ai_usage` has a
  // STRICT policy, so called from inside `runInStoreScope` (every bulk-AI
  // sweep) or a `tenantContext` request (the interactive /stores/:storeId/ai
  // routes), a plain `prisma.aiUsage.count()` is RLS-filtered to the ONE store
  // — the global daily/monthly caps would then never trip and the interactive
  // reserve would never apply, so N sweeping merchants each got the full
  // platform budget. A definer returns one aggregate (no rows) at the cost of
  // one statement; a per-store fan-out would cost a transaction per store on
  // every AI call. Same precedent as answer-engine/budget.ts.
  // The per-store slice stays on the ambient path — it IS store-filtered.
  const [[today, thisMonth], storeToday] = await Promise.all([
    Promise.all([
      countAiUsage({ since: startOfDay, cachedHit: false }),
      countAiUsage({ since: startOfMonth, cachedHit: false }),
    ]),
    opts.storeId
      ? prisma.aiUsage.count({
          where: { storeId: opts.storeId, createdAt: { gte: startOfDay }, cachedHit: false },
        })
      : Promise.resolve(0),
  ]);

  const { dailyCap, monthlyCap, storeDailyCap } = resolveAiCaps();

  if (opts.storeId && storeToday >= storeDailyCap) {
    throw new AppError(
      429,
      AI_QUOTA_STORE_DAILY_CODE,
      `This store's daily AI request cap is reached (${storeToday}/${storeDailyCap}). Resets at 00:00 UTC.`
    );
  }

  // Interactive headroom: bulk sweeps hit their ceiling before the global
  // cap so live single-call features keep working after a sweep saturates.
  const reserveEnv = parseInt(process.env.AI_DAILY_INTERACTIVE_RESERVE ?? '', 10);
  const interactiveReserve = Number.isFinite(reserveEnv) ? reserveEnv : Math.ceil(dailyCap * 0.2);
  const effectiveDailyCap = opts.bulk ? Math.max(0, dailyCap - interactiveReserve) : dailyCap;

  if (today >= effectiveDailyCap) {
    throw new AppError(
      429,
      AI_QUOTA_DAILY_CODE,
      opts.bulk
        ? `Daily AI bulk ceiling reached (${today}/${effectiveDailyCap}; ${interactiveReserve} reserved for interactive calls). Resets at 00:00 UTC.`
        : `Daily AI request cap reached (${today}/${dailyCap}). Resets at 00:00 UTC.`
    );
  }
  if (thisMonth >= monthlyCap) {
    throw new AppError(
      429,
      AI_QUOTA_MONTHLY_CODE,
      `Monthly AI request cap reached (${thisMonth}/${monthlyCap}). Resets next month.`
    );
  }
}
