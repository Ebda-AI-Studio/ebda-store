import { prisma } from '@force/database';
import { AppError } from '../middleware/error-handler';

export const AI_QUOTA_DAILY_CODE = 'AI_QUOTA_DAILY_EXCEEDED';
export const AI_QUOTA_MONTHLY_CODE = 'AI_QUOTA_MONTHLY_EXCEEDED';

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
  return code === AI_QUOTA_DAILY_CODE || code === AI_QUOTA_MONTHLY_CODE;
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
// Defaults are conservative for Google's free tier: 1k requests/day,
// 20k/month. Operator can raise via AI_DAILY_REQUEST_CAP /
// AI_MONTHLY_REQUEST_CAP after enabling billing.
export async function assertAiQuota(): Promise<void> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  const [today, thisMonth] = await Promise.all([
    prisma.aiUsage.count({
      where: { createdAt: { gte: startOfDay }, cachedHit: false },
    }),
    prisma.aiUsage.count({
      where: { createdAt: { gte: startOfMonth }, cachedHit: false },
    }),
  ]);

  const dailyCap = parseInt(process.env.AI_DAILY_REQUEST_CAP ?? '1000', 10);
  const monthlyCap = parseInt(process.env.AI_MONTHLY_REQUEST_CAP ?? '20000', 10);

  if (today >= dailyCap) {
    throw new AppError(
      429,
      AI_QUOTA_DAILY_CODE,
      `Daily AI request cap reached (${today}/${dailyCap}). Resets at 00:00 UTC.`
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
