import { withStore } from '@ebda/database';
import { storeRepo } from './repo-factory';

type TenantTx = Parameters<Parameters<typeof withStore>[1]>[0];

/**
 * `withStore(storeId, tx => <reads>)` that follows the store's backend (NEON-ZERO-1): a store on its Durable Object runs `fn`
 * on its DO read client (the models it names are `store-do`, `Store` is the split record), opening no Postgres transaction;
 * a Postgres store runs the unchanged `withStore`. READS ONLY: the DO client has no write delegates and no interactive
 * transaction, so a write keeps `storeWriter` / `storeUpdate`.
 */
export async function withStoreRead<T>(
  storeId: string,
  fn: (tx: TenantTx) => Promise<T>
): Promise<T> {
  const repo = await storeRepo(storeId);
  if (repo.backend === 'do') return fn(repo.db as unknown as TenantTx);
  return withStore(storeId, fn);
}
