import type { Prisma } from '@ebda/database';
import type { STORE_PLAN_TO_PLAN_CODE } from '@ebda/shared';
import { requestPlanMemo, storeRepo } from './repo-factory';
import { platformDb } from './platform-db';

type Tx = Prisma.TransactionClient;
type LegacyPlan = keyof typeof STORE_PLAN_TO_PLAN_CODE;

/**
 * THE ONE function that answers "what plan is this store on" for an entitlement decision (feature map, plan limits, AI quota,
 * assistant, gates). `tests/unit/entitlement-plan-single-reader.test.ts` fails if entitlement code reads `stores.plan` any other way.
 *
 * A Durable Object store's `plan` in its DO is a COPY; D1 `stores.plan` is authoritative (Ruling NZ-D20). The copy is refreshed after
 * every writer commits (`syncStoreEntitlement`, retried on the jobs queue, hourly reconciler), but a refresh that was missed left a
 * Business store on its OLD tier ("Feature not enabled" on floating_widget), and a stale mirror of a DOWNGRADED store would fail OPEN
 * (paid features kept). The plan is NEVER-stale, so a DO store reads D1, at most ONCE per request and store (`requestPlanMemo`);
 * the DO row is only the fallback when D1 is unbound (Node, tests) or has no row. Postgres stores read their own client.
 * Residual: a plan-version stamp on the mirror would not save the D1 read (comparing it needs the D1 version), so none is kept.
 */
export async function readStorePlan(db: Tx, storeId: string): Promise<{ plan: LegacyPlan } | null> {
  const repo = await storeRepo(storeId);
  if (repo.backend !== 'do') {
    return (await db.store.findUnique({ where: { id: storeId }, select: { plan: true } })) as {
      plan: LegacyPlan;
    } | null;
  }
  return requestPlanMemo(storeId, async () => {
    const platform = await platformDb();
    if (platform) {
      const row = (await platform.store.findUnique({
        where: { id: storeId },
        select: { plan: true },
      })) as { plan: LegacyPlan } | null;
      if (row) return row;
    }
    return (await (repo.db as unknown as Tx).store.findUnique({
      where: { id: storeId },
      select: { plan: true },
    })) as { plan: LegacyPlan } | null;
  });
}
