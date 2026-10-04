/**
 * Keeps `store_subscriptions` in step with FWB's legacy `Store.plan` enum while
 * both exist (SP5 task 1; retiring the enum is a follow-up).
 *
 * Every writer of `stores.plan` that predates the engine (admin PUT
 * /admin/stores/:id, FeatureService.setStorePlan, store creation,
 * provisioning) calls this so the limits a store is held to never disagree
 * with the tier its feature baseline comes from. Takes a Prisma client so it
 * can run inside the caller's transaction.
 */

import type { Prisma } from '@force/database';
import { LEGACY_STORE_PLAN_TO_PLAN_CODE } from '@force/shared';

type LegacyPlan = keyof typeof LEGACY_STORE_PLAN_TO_PLAN_CODE;

/** Mirrors `Store.plan @default(starter)` in schema.prisma — what a new store starts on. */
export const NEW_STORE_LEGACY_PLAN: LegacyPlan = 'starter';

type Db = Pick<Prisma.TransactionClient, 'storeSubscription'>;

export async function syncSubscriptionFromLegacyPlan(
  db: Db,
  storeId: string,
  plan: LegacyPlan
): Promise<void> {
  const planCode = LEGACY_STORE_PLAN_TO_PLAN_CODE[plan];
  const status = planCode === 'comped' ? 'comped' : 'active';
  await db.storeSubscription.upsert({
    where: { storeId },
    create: { storeId, planCode, status },
    // A re-assignment starts a clean over-limit slate.
    update: { planCode, status, ordersOverLimitMonth: null, ordersOverLimitNotifiedAt: null },
  });
}
