import { prisma } from '@force/database';
import { AppError } from '../middleware/error-handler';

export const AI_QUOTA_DAILY_CODE = 'AI_QUOTA_DAILY_EXCEEDED';
export const AI_QUOTA_MONTHLY_CODE = 'AI_QUOTA_MONTHLY_EXCEEDED';

export function isAiQuotaCapError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === AI_QUOTA_DAILY_CODE || code === AI_QUOTA_MONTHLY_CODE;
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
