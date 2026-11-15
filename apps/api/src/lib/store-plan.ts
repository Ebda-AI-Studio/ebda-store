import type { Prisma } from '@ebda/database';
import type { STORE_PLAN_TO_PLAN_CODE } from '@ebda/shared';
import { storeRepo } from './repo-factory';
import { platformDb } from './platform-db';

type Tx = Prisma.TransactionClient;

/**
 * `Store.plan` (the legacy enum the subscription falls back to) from the store's own backend: a Durable Object store's
 * record is its DO, not Postgres (NEON-ZERO-1). Shared by the entitlement read and FeatureService's identical read.
 */
export async function readStorePlan(
  db: Tx,
  storeId: string
): Promise<{ plan: keyof typeof STORE_PLAN_TO_PLAN_CODE } | null> {
  const repo = await storeRepo(storeId);
  const src = repo.backend === 'do' ? (repo.db as unknown as Tx) : db;
  return (await src.store.findUnique({ where: { id: storeId }, select: { plan: true } })) as {
    plan: keyof typeof STORE_PLAN_TO_PLAN_CODE;
  } | null;
}

/**
 * Self-heal for the DO plan mirror (Ruling BIZ-ALL-5). The DO's `plan` is a COPY that every writer refreshes after commit
 * (`syncStoreEntitlement`, retried via the jobs queue and the hourly reconciler); D1 `stores.plan` is authoritative (NZ-D20).
 * A copy that missed its refresh left a Business store on its OLD tier ("Feature not enabled" on floating_widget). This reads
 * D1 ONCE per cold feature-map build (the map is cached 300 s and single-flighted per store), never per request, and when the
 * two disagree it returns D1's value and re-syncs the mirror in the background. `onStale` is injected so tests can observe it.
 */
export async function reconcileDoPlan(
  storeId: string,
  doPlan: keyof typeof STORE_PLAN_TO_PLAN_CODE,
  onStale: (storeId: string) => void
): Promise<keyof typeof STORE_PLAN_TO_PLAN_CODE> {
  const repo = await storeRepo(storeId);
  if (repo.backend !== 'do') return doPlan;
  const platform = await platformDb();
  if (!platform) return doPlan;
  const row = (await platform.store.findUnique({
    where: { id: storeId },
    select: { plan: true },
  })) as {
    plan: keyof typeof STORE_PLAN_TO_PLAN_CODE;
  } | null;
  if (!row || row.plan === doPlan) return doPlan;
  onStale(storeId);
  return row.plan;
}
