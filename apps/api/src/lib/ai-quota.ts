import { resolveAiCaps } from './usage-caps';
import { prisma, withStore } from '@ebda/database';
import { activeAddons } from '../services/billing/addon-grant';
import { ADDON_CATALOG } from '../services/billing/addon-catalog';
import { countAiUsage } from './definer';
import { AppError } from '../middleware/error-handler';
import { AI_DISABLED_BY_MERCHANT_CODE, assertStoreAiEnabled } from './store-ai-switch';

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
  // the store is suspended for billing (store-ai-switch AI_BILLING_SUSPENDED_CODE; a literal so the many test mocks
  // of that module need no new export): a sweep must stop, not fail every remaining product
  'AI_STORE_BILLING_SUSPENDED',
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
 * The STORE's extra daily AI requests from running paid packs (SELF-SERVICE A9). Staleness class: NEVER-stale
 * (entitlement) so it is NOT cached: one indexed ledger read per AI call, noise next to a model round trip, and a
 * pack is usable the moment its payment settles. Only the per-store slice moves; the platform global daily/monthly
 * caps below never read this, so a pack cannot spend the shared Gemini budget.
 */
export async function storeAiExtraRequests(storeId: string, now = new Date()): Promise<number> {
  const running = await withStore(storeId, tx => activeAddons(tx, storeId, now));
  return running.reduce((n, r) => n + (ADDON_CATALOG[r.sku]?.aiExtraRequests ?? 0), 0);
}

/** The platform's daily request cap (Ruling PLANS-1: one platform-wide total from `usage-caps`, not scaled per Gemini key). */
function platformDailyCap(): number {
  return resolveAiCaps().dailyCap;
}

const pct = (env: string | undefined, dflt: number) => {
  const n = parseInt(env ?? '', 10);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : dflt;
};

/**
 * Money-abuse audit P6: a pack raises ONE store's limit, but every call still draws on the SHARED platform pool, so one
 * store on +1000 could drain the day for everyone (Business included). Two ceilings keep that impossible:
 *  - a store's share: no store (pack or not) may spend more than AI_STORE_MAX_SHARE_PCT (default 50) of the platform day;
 *  - a pool reserve: requests funded by a pack (past the store's base slice) stop once the platform has used
 *    AI_TOPUP_POOL_CEILING_PCT (default 70) of its day, so the last 30% stays for base-slice calls of every store.
 * What cannot be delivered is not sold (`quoteAddon` refuses) and the meter shows the deliverable number.
 */
export function maxStoreDailyRequests(): number {
  const share = Math.floor(
    (platformDailyCap() * pct(process.env.AI_STORE_MAX_SHARE_PCT, 50)) / 100
  );
  return Math.max(baseStoreDailyCap(), share);
}

function topupPoolCeiling(): number {
  return Math.floor((platformDailyCap() * pct(process.env.AI_TOPUP_POOL_CEILING_PCT, 70)) / 100);
}

function baseStoreDailyCap(): number {
  return resolveAiCaps().storeDailyCap;
}

/** The multiplier a paid pack puts on the store's own daily limits (1 with no pack); the token budget scales by it. */
export async function storeAiCapFactor(storeId: string): Promise<number> {
  return 1 + (await storeAiExtraRequests(storeId)) / baseStoreDailyCap();
}

const countStoreUsage = (storeId: string, since: Date) =>
  prisma.aiUsage.count({ where: { storeId, createdAt: { gte: since }, cachedHit: false } });

/**
 * What used today's AI requests, by feature (the existing `ai_usage` ledger; cached hits cost nothing and are excluded,
 * exactly as the cap counts them). Bounded read: a day is at most the cap, so the take never truncates real usage.
 */
export async function storeAiUsageByFeature(
  storeId: string
): Promise<Array<{ feature: string; count: number }>> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const rows = await withStore(storeId, tx =>
    tx.aiUsage.findMany({
      where: { storeId, createdAt: { gte: startOfDay }, cachedHit: false },
      select: { feature: true },
      take: 5000,
    })
  );
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.feature, (counts.get(r.feature) ?? 0) + 1);
  return [...counts.entries()]
    .map(([feature, count]) => ({ feature, count }))
    .sort((a, b) => b.count - a.count);
}

/** What the merchant sees in AI settings: base cap, paid extra, used today, remaining. */
export async function storeAiAllowance(storeId: string) {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const [extra, used] = await Promise.all([
    storeAiExtraRequests(storeId),
    countStoreUsage(storeId, startOfDay),
  ]);
  const baseCap = baseStoreDailyCap();
  const cap = Math.min(baseCap + extra, maxStoreDailyRequests());
  return { baseCap, extra, cap, used, remaining: Math.max(0, cap - used) };
}

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
  if (opts.storeId) await assertStoreAiEnabled(opts.storeId);

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
  const [[today, thisMonth], storeToday, storeExtra] = await Promise.all([
    Promise.all([
      countAiUsage({ since: startOfDay, cachedHit: false }),
      countAiUsage({ since: startOfMonth, cachedHit: false }),
    ]),
    opts.storeId ? countStoreUsage(opts.storeId, startOfDay) : Promise.resolve(0),
    opts.storeId ? storeAiExtraRequests(opts.storeId) : Promise.resolve(0),
  ]);

  // Caps live in ./usage-caps (Ruling PLANS-1: platform-wide, never scaled by the Gemini key count); a paid pack raises only
  // the per-store slice, up to the store's maximum share of the platform day.
  const { dailyCap, monthlyCap, storeDailyCap: baseSlice } = resolveAiCaps();
  const storeDailyCap = Math.min(baseSlice + storeExtra, maxStoreDailyRequests());

  if (opts.storeId && storeToday >= storeDailyCap) {
    throw new AppError(
      429,
      AI_QUOTA_STORE_DAILY_CODE,
      `This store's daily AI request cap is reached (${storeToday}/${storeDailyCap}). Resets at 00:00 UTC. Need more? Buy a request pack in Billing > Add-ons.`
    );
  }

  // A call past the base slice is funded by a pack: it may only use the pool while the pool is not nearly spent, so a
  // top-up can never starve the base-slice calls of other stores.
  if (
    opts.storeId &&
    storeExtra > 0 &&
    storeToday >= baseStoreDailyCap() &&
    today >= topupPoolCeiling()
  ) {
    throw new AppError(
      429,
      AI_QUOTA_DAILY_CODE,
      `The shared AI capacity is busy (${today}/${dailyCap}), so top-up requests pause until it eases or resets at 00:00 UTC.`
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
