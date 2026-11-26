/**
 * Plan-limit levels: the ONE place that turns "used of limit" into ok / warn / full.
 * The billing meters (UsageBar), the dashboard and the per-screen notices all call this,
 * so a store can never be "79% green" on one screen and "amber" on another.
 *
 *   used / limit  <  80%   -> ok    (no warning)
 *   used / limit >= 80%   -> warn  (amber, upgrade CTA)
 *   used / limit >= 100%  -> full  (limit reached, upgrade CTA)
 * `limit === null` is "unlimited" (never warns); `limit === 0` is a plan that includes none (full).
 */
export type LimitLevel = 'ok' | 'warn' | 'full';

const WARN_AT = 0.8;

export function limitPct(used: number, limit: number | null): number {
  if (limit === null) return 0;
  if (limit <= 0) return 100;
  return Math.min(100, Math.round((used / limit) * 100));
}

export function limitLevel(used: number, limit: number | null | undefined): LimitLevel {
  if (limit === null || limit === undefined) return 'ok';
  if (limit <= 0) return 'full';
  if (used >= limit) return 'full';
  // compare the raw ratio (not the rounded %) so 79.6% never reads as the 80% threshold
  return used / limit >= WARN_AT ? 'warn' : 'ok';
}

/** The worse of two levels (AI has a daily AND a monthly cap). */
export function worstLevel(a: LimitLevel, b: LimitLevel): LimitLevel {
  const order: LimitLevel[] = ['ok', 'warn', 'full'];
  return order[Math.max(order.indexOf(a), order.indexOf(b))];
}
