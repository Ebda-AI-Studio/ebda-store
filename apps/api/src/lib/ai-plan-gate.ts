/**
 * AI spend is a paid-plan feature (Ruling AI-PLAN-GATE-1): a store whose EFFECTIVE plan is `free` (never subscribed, or
 * a canceled subscription falling back to free) gets no AI at Ebda's cost. `assertAiQuota` asks this before it counts
 * anything, so every spend path that budgets through it is covered without per-route edits.
 *
 * Allowed: trialing, active, past_due (the dunning grace is the billing job's call, not this gate's), comped, and any
 * non-free effective plan. Refused: effective plan `free` unless the subscription is trialing or comped.
 *
 * Staleness class: NEVER-stale (an entitlement). No cache: `getEntitlements` is one subscription read per AI call,
 * noise next to a model round trip, so a cancel is obeyed on the very next call.
 */
import { FALLBACK_PLAN_CODE } from '@ebda/shared';
import { AppError } from '../middleware/error-handler';
import { getEntitlements } from '../services/plan-entitlements';

const AI_PLAN_REQUIRED_CODE = 'AI_PLAN_REQUIRED';

export async function assertStoreAiPlan(storeId: string): Promise<void> {
  // A store whose plan cannot be read is NOT entitled: fail closed.
  const e = await getEntitlements(storeId);
  if (e && (e.status === 'trialing' || e.status === 'comped' || e.planCode !== FALLBACK_PLAN_CODE))
    return;
  throw new AppError(
    402,
    AI_PLAN_REQUIRED_CODE,
    'AI tools need a paid plan. Upgrade your plan to use them.',
    {
      messageEn: 'AI tools need a paid plan. Upgrade your plan to use them.',
      messageAr: 'أدوات الذكاء الاصطناعي متاحة في الباقات المدفوعة بس. رقّي باقتك عشان تستخدمها.',
    }
  );
}
