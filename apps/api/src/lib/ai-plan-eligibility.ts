/**
 * AI eligibility by plan.
 *
 * The AI-first policy (2026-07-21) puts every AI capability in every *paid*
 * plan baseline. `free` is deliberately excluded: it is the stripped
 * demo / lapsed-payment grace state, not a plan anyone buys.
 *
 * Feature keys alone cannot express that exclusion for the AI inventory
 * scans, because they gate on `inventory.basic` — a data-model key that
 * `free` legitimately has so a lapsed merchant can still see their own
 * stock. Without this guard, a non-paying tenant would burn Gemini quota
 * on the daily dead-stock and reorder sweeps.
 *
 * The scan crons already filter on `accountingEnabled && aiFeaturesEnabled`,
 * but those are per-store toggles a merchant controls — not a plan gate.
 */
import type { StorePlan } from '@force/shared';

/** Plans excluded from AI spend. Keep in sync with PLAN_BASELINE.free. */
const AI_INELIGIBLE_PLANS: readonly StorePlan[] = ['free'] as const;

/**
 * Prisma `where` fragment for the scan crons enumerating eligible stores.
 * Deliberately not `as const`: Prisma's generated `notIn` wants a mutable
 * array, and a readonly one fails to typecheck against `StoreWhereInput`.
 */
export const aiEligiblePlanFilter: { plan: { notIn: StorePlan[] } } = {
  plan: { notIn: [...AI_INELIGIBLE_PLANS] },
};

/** True when a store's plan may consume AI budget. */
export function isAiEligiblePlan(plan: StorePlan): boolean {
  return !AI_INELIGIBLE_PLANS.includes(plan);
}
