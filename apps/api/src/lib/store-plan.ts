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
  if (repo.backend === 'do') {
    // D1 `stores.plan` is the AUTHORITATIVE copy of the entitlement field (Ruling NZ-D20: the one writer is D1 first, the DO copy
    // follows and a failed copy is only retried later). Reading the DO's mirror let a store that was upgraded to Business keep
    // resolving its OLD tier, so Business-only features (floating_widget) showed "Feature not enabled" on a Business store.
    const platform = await platformDb();
    if (platform) {
      const row = (await platform.store.findUnique({
        where: { id: storeId },
        select: { plan: true },
      })) as { plan: keyof typeof STORE_PLAN_TO_PLAN_CODE } | null;
      if (row) return row;
    }
  }
  const src = repo.backend === 'do' ? (repo.db as unknown as Tx) : db;
  return (await src.store.findUnique({ where: { id: storeId }, select: { plan: true } })) as {
    plan: keyof typeof STORE_PLAN_TO_PLAN_CODE;
  } | null;
}
