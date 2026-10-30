/**
 * The page ledger: how many catalogue pages a store may still extract. Rows are counted, never a
 * stored counter (no drift, nothing to reset): every model call that returns a reply adds the
 * file's pages to `charged_pages`, so a retry that reaches the model is charged again (a retry that
 * fails before the model is called is free, and attempts are capped at CATALOG_IMPORT_MAX_ATTEMPTS). The monthly figure comes from
 * `plans.limits.catalogImportPagesPerMonth` (null = unlimited, 0 = not included); the per-job,
 * per-day and per-file numbers are env defaults. This is IN ADDITION to `assertAiQuota`.
 */
import { prisma } from '@ebda/database';
import { regionMonthStart, regionYearMonth } from '@ebda/shared';
import { getEntitlements } from '../../services/plan-entitlements';

const int = (v: string | undefined, d: number) => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

export const catalogueLimits = () => ({
  maxPagesPerJob: int(process.env.CATALOG_IMPORT_MAX_PAGES_PER_JOB, 30),
  maxPagesPerDay: int(process.env.CATALOG_IMPORT_MAX_PAGES_PER_DAY, 60),
  maxFilesPerJob: int(process.env.CATALOG_IMPORT_MAX_FILES_PER_JOB, 4),
  maxAttempts: int(process.env.CATALOG_IMPORT_MAX_ATTEMPTS, 3),
  maxActiveJobs: int(process.env.CATALOG_IMPORT_MAX_ACTIVE_JOBS, 2),
  maxImageBytes: int(process.env.CATALOG_IMPORT_MAX_IMAGE_BYTES, 6 * 1024 * 1024),
  maxPdfBytes: int(process.env.CATALOG_IMPORT_MAX_PDF_BYTES, 6 * 1024 * 1024),
  maxPdfPages: int(process.env.CATALOG_IMPORT_MAX_PDF_PAGES, 10),
  minGapMs: int(process.env.CATALOG_IMPORT_MIN_GAP_MS, 2500),
});

/** Kill switch: `CATALOG_IMPORT_ENABLED=false` turns the whole feature off (default on). */
export function catalogImportKillSwitchOn(): boolean {
  return process.env.CATALOG_IMPORT_ENABLED === 'false';
}

export interface PageAllowance {
  /** null = unlimited plan */
  monthlyLimit: number | null;
  usedMonth: number;
  usedToday: number;
  remainingMonth: number | null;
  remainingToday: number;
  enabled: boolean;
}

/** Call inside the store's scope (a request, or `runInStoreScope`). */
export async function pageAllowance(storeId: string): Promise<PageAllowance> {
  const e = await getEntitlements(storeId);
  const monthlyLimit = e ? e.limits.catalogImportPagesPerMonth : 0;
  const monthStart = regionMonthStart(regionYearMonth(new Date()));
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const sum = async (since: Date) =>
    (
      await prisma.catalogImportFile.aggregate({
        where: { storeId, chargedPages: { gt: 0 }, startedAt: { gte: since } },
        _sum: { chargedPages: true },
      })
    )._sum.chargedPages ?? 0;
  const [usedMonth, usedToday] = await Promise.all([sum(monthStart), sum(dayStart)]);
  const lim = catalogueLimits();
  return {
    monthlyLimit,
    usedMonth,
    usedToday,
    remainingMonth: monthlyLimit === null ? null : Math.max(0, monthlyLimit - usedMonth),
    remainingToday: Math.max(0, lim.maxPagesPerDay - usedToday),
    enabled: !catalogImportKillSwitchOn() && (monthlyLimit === null || monthlyLimit > 0),
  };
}

/** Can a file of `pages` pages be charged now? Returns the reason code when it cannot. */
export function chargeVerdict(
  a: PageAllowance,
  pages: number
): 'ok' | 'PLAN_PAGES_EXHAUSTED' | 'DAILY_PAGES_EXHAUSTED' {
  if (a.remainingMonth !== null && a.remainingMonth < pages) return 'PLAN_PAGES_EXHAUSTED';
  if (a.remainingToday < pages) return 'DAILY_PAGES_EXHAUSTED';
  return 'ok';
}
