import type { Prisma } from '@ebda/database';
import type { STORE_PLAN_TO_PLAN_CODE } from '@ebda/shared';
import { storeRepo } from './repo-factory';

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
