/** Platform + per-store AI request caps. Pure (env only) so route code can import it without the DB-bound ai-quota module. */
// Production AI cap (Ruling PLANS-1, Ahmad; register G36): the platform runs on 2 Gemini keys in 2 Google projects
// (~2000 requests/day free tier), so the PLATFORM-WIDE default is 1800/day with ~10% headroom, and 54000/month
// (1800 x 30). These are totals for the whole platform, not per key: they do NOT scale with the key count.
// Override via AI_DAILY_REQUEST_CAP / AI_MONTHLY_REQUEST_CAP; raise only when Google billing is enabled.
const DEFAULT_DAILY_REQUEST_CAP = 1800;
const DEFAULT_MONTHLY_REQUEST_CAP = 54000;
// Per-store BASE slice beneath the platform cap: without it one merchant's bulk sweep drains the shared cap and
// denies AI to every other tenant. The base stays 150/day; the room between it and a store's MAXIMUM share (50% of the
// platform day, 900 at 1800, `maxStoreDailyRequests` in the add-ons stack) is what AI top-ups sell (Ruling PLANS-1,
// register G36 "top-ups sellable within store share"). A base AT the share would leave no top-up the platform can back
// (every pack refused AI_CAPACITY_UNAVAILABLE). An explicit AI_STORE_DAILY_REQUEST_CAP is honoured but never exceeds
// the platform daily cap.
const DEFAULT_STORE_DAILY_REQUEST_CAP = 150;

function envInt(name: string): number | null {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The effective platform + per-store AI request caps. Single source for assertAiQuota and the usage endpoints. */
export function resolveAiCaps(): { dailyCap: number; monthlyCap: number; storeDailyCap: number } {
  const dailyCap = envInt('AI_DAILY_REQUEST_CAP') ?? DEFAULT_DAILY_REQUEST_CAP;
  const monthlyCap = envInt('AI_MONTHLY_REQUEST_CAP') ?? DEFAULT_MONTHLY_REQUEST_CAP;
  const storeDailyCap = Math.min(
    envInt('AI_STORE_DAILY_REQUEST_CAP') ?? DEFAULT_STORE_DAILY_REQUEST_CAP,
    dailyCap
  );
  return { dailyCap, monthlyCap, storeDailyCap };
}
