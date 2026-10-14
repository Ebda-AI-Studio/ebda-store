/**
 * Start the signup trial inside the caller's (store-scoped) transaction: Growth
 * for 14 days whatever plan was chosen; the chosen plan + interval wait in
 * `pendingPlanCode` / `billingInterval` for the trial-end charge (Ruling
 * EBDA-FUNNEL-3). The trial clock restarts when the first card is saved
 * (EBDA-FUNNEL-4), so these dates are the setup window until then.
 */
import type { Prisma } from '@ebda/database';
import { addDays, TRIAL_DAYS, TRIAL_PLAN_CODE, type BillingInterval } from './period';

export interface TrialChoice {
  planCode: string;
  interval: BillingInterval;
}

/** Plans a merchant may pick at signup (public + priced, checked again server-side). */
export const SIGNUP_PLAN_CODES = ['basic', 'growth', 'business'] as const;
export type SignupPlanCode = (typeof SIGNUP_PLAN_CODES)[number];
export const DEFAULT_TRIAL_CHOICE: TrialChoice = { planCode: TRIAL_PLAN_CODE, interval: 'monthly' };

export async function startSignupTrial(
  tx: Pick<Prisma.TransactionClient, 'storeSubscription'>,
  storeId: string,
  choice: TrialChoice = DEFAULT_TRIAL_CHOICE,
  now: Date = new Date()
): Promise<void> {
  const trialEndsAt = addDays(now, TRIAL_DAYS);
  await tx.storeSubscription.update({
    where: { storeId },
    data: {
      planCode: TRIAL_PLAN_CODE,
      status: 'trialing',
      trialEndsAt,
      currentPeriodStart: now,
      currentPeriodEnd: trialEndsAt,
      pendingPlanCode: choice.planCode,
      billingInterval: choice.interval,
    },
  });
}
