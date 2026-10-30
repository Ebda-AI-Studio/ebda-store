/**
 * Store data access for a PORTED job (lib/jobs/job-data.ts): one helper that works for either backend.
 * On the Durable Object the read client talks to the store's DO directly. On Postgres the same client is the `prisma`
 * proxy, so it needs the store's tenant scope, exactly as before the port.
 */
import {
  acrossStores,
  prisma,
  runInStoreScope,
  runInTenantContext,
  withStore,
} from '@ebda/database';
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
 * works unchanged for both. (Ruling CF-JOBS-4.)
 */
export async function runInStoreCtx<T>(storeId: string, fn: () => Promise<T>): Promise<T> {
  const repo = await storeRepo(storeId);
  if (repo.backend === 'do') return runInStoreScope(storeId, fn);
  return runInTenantContext(storeId, fn);
}

/**
 * A store-by-store sweep for a PORTED job (Ruling CF-JOBS-4). The cron run lists the Postgres stores exactly as before
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

/**
 * A store's display name for an alert or message. `Store` is a platform row (D1 target, still read from Postgres until the
 * platform moves), so this reads it for either backend; any failure falls back to the id (a message must never fail a job).
 */
export async function storeNameOf(storeId: string): Promise<string> {
  try {
    const s = await withStore(storeId, tx =>
      tx.store.findUnique({ where: { id: storeId }, select: { name: true } })
    );
    return s?.name ?? storeId;
  } catch {
    return storeId;
  }
}

/**
 * Run `fn` once per store for a PORTED job (Ruling CF-JOBS-4), like `acrossStores`: the cron run visits the Postgres stores
 * (each in its tenant scope; the runner hides the DO stores), the alarm run of a DO store visits that one store through its
 * Durable Object. `fn` gets the store's read client.
 */
export async function acrossStoresDb(
  event: { data?: unknown } | undefined,
  fn: (storeId: string, db: StoreReads) => Promise<void>,
  opts: { concurrency?: number } = {}
): Promise<void> {
  const only = alarmStoreId(event);
  const repo = only ? await storeRepo(only) : undefined;
  if (only && repo?.backend === 'do') {
    await fn(only, repo.db);
    return;
  }
  await acrossStores(storeId => fn(storeId, prisma as unknown as StoreReads), {
    ...opts,
    ...(only ? { storeIds: [only] } : {}),
  });
}

/**
 * A read for a store, by its backend (Ruling CF-JOBS-4): a store on its Durable Object reads its DO; a Postgres store keeps
 * today's `runInTenantContext` + `prisma` exactly. For shared code (the WhatsApp link and consent reads) used by requests
 * and jobs alike, where `withStoreDb` would change the Postgres scope.
 */
export async function readStoreDb<T>(
  storeId: string,
  fn: (db: StoreReads) => Promise<T>
): Promise<T> {
  const repo = await storeRepo(storeId);
  if (repo.backend === 'do') return fn(repo.db);
  return runInTenantContext(storeId, () => fn(repo.db));
}
