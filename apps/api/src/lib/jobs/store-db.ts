/**
 * Store data access for a PORTED job (lib/jobs/job-data.ts): one helper that works for either backend.
 * On the Durable Object the read client talks to the store's DO directly. On Postgres the same client is the `prisma`
 * proxy, so it needs the store's tenant scope, exactly as before the port.
 */
import { customerRows } from '../customer-directory';
import { lookupStore } from '../definer';
import { backendFor } from '../store-backend';
import { AppError } from '../../middleware/error-handler';
import logger from '../logger';
import {
  acrossStores,
  prisma,
  runInStoreScope,
  runInTenantContext,
  storeDirectory,
  withoutHiddenStores,
  withStore,
  type StoreDirectoryEntry,
} from '@ebda/database';
import {
  storeDb,
  storeRepo,
  storeWriter,
  type StoreReads,
  type StoreWrites,
} from '../repo-factory';
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
    const s = await withStoreDb(storeId, db =>
      db.store.findUnique({ where: { id: storeId }, select: { name: true } })
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
  const res = await acrossStores(storeId => fn(storeId, prisma as unknown as StoreReads), {
    ...opts,
    ...(only ? { storeIds: [only] } : {}),
  });
  // Every other store was visited (isolation, #619); fail the run LOUDLY after the sweep so the failure watch sees it.
  if ((res.failures?.length ?? 0) > 0)
    throw new Error(`${res.failures.length} store(s) failed in the sweep; see the per-store log`);
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

/**
 * The shoppers (platform `User` rows registered on THIS store) behind a list of customer ids, for rows a job read from a store's
 * Durable Object: `Order.customer` is a join into the platform database, which the DO cannot do (Ruling CF-R2-1 attaches it the
 * same way for requests). The select and the visibility are the Postgres relation's: a user of this store only (Ruling CF-JOBS-4).
 */
export async function customersById(
  storeId: string,
  ids: ReadonlyArray<string | null | undefined>
): Promise<
  Map<
    string,
    {
      id: string;
      firstName: string | null;
      lastName: string | null;
      email: string | null;
      phone: string | null;
      language: string | null;
    }
  >
> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (want.length === 0) return new Map();
  const doUsers = await customerRows(storeId, want);
  // an erased / deleted account is not a recipient (its email is anonymised)
  if (doUsers) return new Map(doUsers.filter(u => u.deletedAt === null).map(u => [u.id, u]));
  const users = await withStore(storeId, tx =>
    tx.user.findMany({
      where: { id: { in: want }, storeId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        language: true,
      },
    })
  );
  return new Map(users.map(u => [u.id, u]));
}

/** The tenant client `withStore` hands its callback. */
export type StoreTx = Parameters<Parameters<typeof withStore>[1]>[0];

/**
 * Read AND write a store's rows through one `tx`-shaped client, for services written against `withStore(storeId, tx => ...)`
 * (Ruling CF-JOBS-4B). A Postgres store gets exactly `withStore` (the tenant scope and its RLS GUCs, unchanged). A store on its
 * Durable Object gets each model delegate as the DO read client's find/count/aggregate plus the DO writer's create/update/delete
 * ops: a model the DO does not accept writes for (`DO_WRITABLE_MODELS`) has no write method, so a write to it throws instead of
 * reaching Postgres. Each write is one atomic DO call; a service that needs two writes to land together must not use this.
 */
export async function withStoreRw<T>(storeId: string, fn: (db: StoreTx) => Promise<T>): Promise<T> {
  const repo = await storeRepo(storeId);
  if (repo.backend !== 'do') return withStore(storeId, tx => fn(tx));
  const reads = repo.db as unknown as Record<string, object>;
  const writes = repo.writer as unknown as Record<string, object>;
  const merged = new Proxy(
    {},
    {
      get: (_t, model: string) =>
        model === '$transaction'
          ? (writes as Record<string, unknown>)[model]
          : { ...(reads[model] ?? {}), ...(writes[model] ?? {}) },
    }
  );
  return fn(merged as unknown as StoreTx);
}

/**
 * Every store, DO stores included (Ruling CF-JOBS-4). A job's run hides the DO stores from `storeDirectory` so a sweep that
 * is not ported cannot reach their sealed Postgres rows; a job that covers each store through `storeRepo` itself lists
 * them with this. The alarm run of a store lists that store only.
 */
export function allStoresDirectory(
  event: { data?: unknown } | undefined,
  filter?: (s: StoreDirectoryEntry) => boolean
): Promise<StoreDirectoryEntry[]> {
  const only = alarmStoreId(event);
  return withoutHiddenStores(() =>
    storeDirectory(s => (only === undefined || s.id === only) && (filter ? filter(s) : true))
  );
}

/**
 * Run `fn` once per store for a job that covers EVERY store from its one cron run, Postgres and DO alike (Ruling CF-JOBS-4):
 * for a DO store its Durable Object read client in the store's scope, for a Postgres store `prisma` in its tenant
 * transaction, exactly as `acrossStores`. A cross-store aggregate (a watcher ranking stores, a leader-locked sweep with one
 * shared quota) cannot be split into per-store alarms without losing the aggregate, so it lists the DO stores itself.
 */
export async function acrossAllStoresDb<T>(
  event: { data?: unknown } | undefined,
  fn: (storeId: string, db: StoreReads) => Promise<T>,
  opts: {
    concurrency?: number;
    filter?: (s: StoreDirectoryEntry) => boolean;
    storeIds?: string[];
  } = {}
): Promise<Array<{ storeId: string; value: T }>> {
  const ids = opts.storeIds ?? (await allStoresDirectory(event, opts.filter)).map(s => s.id);
  const out: Array<{ storeId: string; value: T } | undefined> = new Array(ids.length);
  let next = 0;
  let failure: { err: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (!failure) {
      const i = next++;
      if (i >= ids.length) return;
      const storeId = ids[i];
      try {
        const repo = await storeRepo(storeId);
        out[i] = {
          storeId,
          value:
            repo.backend === 'do'
              ? await runInStoreScope(storeId, () => fn(storeId, repo.db))
              : await runInTenantContext(storeId, () => fn(storeId, repo.db)),
        };
      } catch (err) {
        failure = { err };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, ids.length || 1)) }, worker)
  );
  if (failure) throw failure.err;
  return out.filter((r): r is { storeId: string; value: T } => r !== undefined);
}

/**
 * A store client that is resolved on EACH call, for a Workflow handler (Ruling CF-JOBS-4): outside `step.run` a Workflow
 * holds no database connection and is re-executed on every replay, so the backend flag must not be read at the top of the
 * handler. `db.product.findMany(...)` here is `(await storeDb(storeId)).product.findMany(...)`, resolved inside whatever step
 * makes the call. NOT for `$transaction([...])` (its operations would already be running): take a real client inside the step.
 */
function lazyClient<T>(resolve: () => Promise<unknown>): T {
  return new Proxy(
    {},
    {
      get: (_t, model: string) =>
        new Proxy(
          {},
          {
            get:
              (_m, op: string) =>
              async (...args: unknown[]) => {
                const c = (await resolve()) as Record<
                  string,
                  Record<string, (...a: unknown[]) => unknown>
                >;
                return c[model][op](...args);
              },
          }
        ),
    }
  ) as T;
}
export function lazyStoreDb(storeId: string): StoreReads {
  return lazyClient<StoreReads>(() => storeDb(storeId));
}
export function lazyStoreWriter(storeId: string): Omit<StoreWrites, '$transaction' | '$proc'> {
  return lazyClient<Omit<StoreWrites, '$transaction' | '$proc'>>(() => storeWriter(storeId));
}

/**
 * A read-write client for a service that runs inside its caller's store scope (`runInStoreCtx`): the `prisma` proxy for a
 * Postgres store (the ambient tenant transaction, unchanged), the DO read client merged with the DO writer for a store on its
 * Durable Object (see `withStoreRw`). `onDo` lets a caller skip what only Postgres needs (a savepoint).
 */
export async function storeRwClient(storeId: string): Promise<{ db: StoreTx; onDo: boolean }> {
  const repo = await storeRepo(storeId);
  if (repo.backend !== 'do') return { db: prisma as unknown as StoreTx, onDo: false };
  const reads = repo.db as unknown as Record<string, object>;
  const writes = repo.writer as unknown as Record<string, object>;
  const merged = new Proxy(
    {},
    {
      get: (_t, model: string) => ({ ...(reads[model] ?? {}), ...(writes[model] ?? {}) }),
    }
  );
  return { db: merged as unknown as StoreTx, onDo: true };
}

/**
 * May an event-triggered job (comms: review request, scheduled campaign, lifecycle emails) still act for this store?
 * False when the store is not `active` (inactive / suspended), soft-deleted, unknown, or its storage is gone (a `pg`
 * directory row on Workers answers 410 STORE_STORAGE_REMOVED). The caller SKIPS on false instead of throwing: a retry can
 * never make a closed store open, and each failed attempt was a production error (review-request, 2026-11-10, several a
 * minute). An unreadable directory (503) still throws, so a transient outage retries rather than dropping the message.
 * Logged once per call at debug level (the job runs it inside one memoised step).
 */
export async function storeActiveForJob(storeId: string, job: string): Promise<boolean> {
  const skip = (reason: string) => {
    logger.debug({ storeId, job, reason }, '[jobs] store not active; skipping');
    return false;
  };
  if (!(await lookupStore({ id: storeId }, ['active']))) return skip('not_active');
  try {
    await backendFor(storeId);
  } catch (err) {
    if (err instanceof AppError && (err.statusCode === 410 || err.statusCode === 404)) {
      return skip(err.code);
    }
    throw err;
  }
  return true;
}
