/**
 * Store data access for a PORTED job (lib/jobs/job-data.ts): one helper that works for either backend.
 * On the Durable Object the read client talks to the store's DO directly. On Postgres the same client is the `prisma`
 * proxy, so it needs the store's tenant scope, exactly as before the port.
 */
import { prisma, runInStoreScope, runInTenantContext } from '@ebda/database';
import { storeRepo, type StoreReads } from '../repo-factory';
import { sweepAcrossStores } from '../cross-store';
import { alarmStoreId } from './store-scope';

export async function withStoreDb<T>(
  storeId: string,
  fn: (db: StoreReads) => Promise<T>
): Promise<T> {
  const repo = await storeRepo(storeId);
  if (repo.backend === 'do') return fn(repo.db);
  return runInStoreScope(storeId, () => fn(repo.db));
}

/**
 * The ambient store of a ported job body: `runInTenantContext` (one Postgres transaction, RLS GUCs) for a store on
 * Postgres, only the ambient store id (`runInStoreScope`, no transaction, no connection) for a store on its Durable
 * Object, whose rows are not in Postgres. Code inside (`currentStoreId()`, platform reads such as `featureService`)
 * works unchanged for both. (Ruling CF-JOBS-3.)
 */
export async function runInStoreCtx<T>(storeId: string, fn: () => Promise<T>): Promise<T> {
  const repo = await storeRepo(storeId);
  if (repo.backend === 'do') return runInStoreScope(storeId, fn);
  return runInTenantContext(storeId, fn);
}

/**
 * A store-by-store sweep for a PORTED job (Ruling CF-JOBS-3). The cron run lists the Postgres stores exactly as before
 * (`sweepAcrossStores`, one tenant transaction per store; the runner hides the DO stores from it). The alarm run of a DO
 * store (`alarmStoreId`) reads that one store through its Durable Object. `fetch` gets the store's read client, so one body
 * serves both backends and never touches `prisma` itself.
 */
export async function sweepStoresDb<T>(
  event: { data?: unknown } | undefined,
  args: {
    fetch: (storeId: string, db: StoreReads) => Promise<T[]>;
    orderKey: (row: T) => Date | number;
    take: number;
    desc?: boolean;
  }
): Promise<T[]> {
  const only = alarmStoreId(event);
  const repo = only ? await storeRepo(only) : undefined;
  if (only && repo?.backend === 'do') {
    const key = (r: T): number => {
      const k = args.orderKey(r);
      return k instanceof Date ? k.getTime() : k;
    };
    const dir = args.desc ? -1 : 1;
    const rows = await args.fetch(only, repo.db);
    return rows.sort((a, b) => dir * (key(a) - key(b))).slice(0, args.take);
  }
  return sweepAcrossStores({
    fetch: storeId => args.fetch(storeId, prisma as unknown as StoreReads),
    orderKey: args.orderKey,
    take: args.take,
    desc: args.desc,
    storeIds: only ? [only] : undefined,
  });
}
