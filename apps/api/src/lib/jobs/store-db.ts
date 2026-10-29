/**
 * Store data access for a PORTED job (lib/jobs/job-data.ts): one helper that works for either backend.
 * On the Durable Object the read client talks to the store's DO directly. On Postgres the same client is the `prisma`
 * proxy, so it needs the store's tenant scope, exactly as before the port.
 */
import { runInStoreScope } from '@ebda/database';
import { storeRepo, type StoreReads } from '../repo-factory';

export async function withStoreDb<T>(
  storeId: string,
  fn: (db: StoreReads) => Promise<T>
): Promise<T> {
  const repo = await storeRepo(storeId);
  if (repo.backend === 'do') return fn(repo.db);
  return runInStoreScope(storeId, () => fn(repo.db));
}
