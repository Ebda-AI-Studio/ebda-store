/**
 * Stable API of the subscription family for callers outside services/billing (store create on a StoreDO, onboarding,
 * admin). Nothing here knows whether a row lives in Postgres or D1: the `prisma` proxy routes the billing models
 * (services/platform/router.ts) once the family's cutover marker exists. What this module adds is the SCOPE: after the
 * cutover it never opens a Postgres transaction just to read or write a platform row.
 *
 *   getStoreSubscription(storeId)              the store's subscription row, or null
 *   startSignupTrial(tx, storeId, choice?, now)  14-day Growth trial on the store's row (re-export, billing/trial.ts)
 *   syncSubscriptionFromLegacyPlan(tx, ...)    keep the row in step with `stores.plan` (re-export, plan-sync.ts)
 *   withPlatformScope(storeId, fn)             run `fn(tx)` where `tx.storeSubscription` / `tx.plan` / ... work
 *
 * Budget: getStoreSubscription = 1 D1 primary read on D1, 0 Postgres.
 */
import { prisma, withStore, type Prisma } from '@ebda/database';
import { platformFamilyOnD1 } from './cutover';

export { startSignupTrial, DEFAULT_TRIAL_CHOICE } from '../billing/trial';
export type { TrialChoice } from '../billing/trial';
export { syncSubscriptionFromLegacyPlan, NEW_STORE_LEGACY_PLAN } from '../plan-sync';

type Tx = Prisma.TransactionClient;

/**
 * `withStore` before the cutover (strict RLS needs the store scope); after it the billing models are served by D1 with
 * no transaction, so the proxy itself is the client. A callback that ALSO touches Postgres-owned models after the
 * cutover must use `withStore` directly.
 */
export async function withPlatformScope<T>(
  storeId: string,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  if (await platformFamilyOnD1('billing')) return fn(prisma as unknown as Tx);
  return withStore(storeId, fn);
}

export function getStoreSubscription(storeId: string) {
  return withPlatformScope(storeId, tx => tx.storeSubscription.findUnique({ where: { storeId } }));
}
