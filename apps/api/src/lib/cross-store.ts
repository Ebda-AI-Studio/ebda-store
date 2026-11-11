import { acrossStores, acrossStoresFlat, withUser } from '@ebda/database';
import { ownedStoreIds as definerOwnedStoreIds } from './definer';
import { hubFanoutStoreIds, hubOnD1 } from './platform-hub';

/**
 * Merge helpers for reads that span stores (super-admin dashboards, platform
 * sweeps) under strict RLS.
 *
 * `acrossStores` runs the callback once per store, each in that store's own
 * tenant transaction, so the callback only ever sees one store's rows. A
 * global `orderBy` / `take` / `skip` / `count` therefore has to be MERGED by the
 * caller; these helpers do the merges the API needs.
 */

/**
 * Drop repeated rows (same `id`). Under RLS each store's scope shows only that store's rows, so
 * the per-store results are disjoint; on an owner-role connection (dev, scripts, tests: RLS is
 * bypassed) EVERY store's scope sees every row, and the merge would repeat each one per store.
 */
function dedupeById<T>(rows: T[]): T[] {
  const seen = new Set<unknown>();
  return rows.filter(r => {
    const id = (r as { id?: unknown } | null)?.id;
    if (id === undefined) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/**
 * One page of a list ordered by a timestamp, across stores.
 *
 * Page `skip..skip+take` of the global ordering is contained in the first
 * `skip + take` rows of every store's own ordering, so each store is asked for
 * that window, the windows are merged, sorted and cut. `total` is the sum of the
 * per-store counts.
 */
export async function pageAcrossStores<T>(args: {
  /** Limit to these stores (e.g. a `storeId` query filter, or a store admin's own stores). */
  storeIds?: string[];
  skip: number;
  take: number;
  /** The sort key of a row (a Date or number). */
  orderKey: (row: T) => Date | number;
  /** Newest/highest first (default). */
  desc?: boolean;
  /** One store's window of rows and its total row count, inside that store's scope. */
  fetch: (window: number) => Promise<{ rows: T[]; total: number }>;
}): Promise<{ rows: T[]; total: number }> {
  const window = args.skip + args.take;
  // NEON-ZERO (Ruling NZ-C-4): no Postgres directory once the platform families are on D1 - the store list is D1's (capped).
  const storeIds =
    args.storeIds ?? ((await hubOnD1()) ? (await hubFanoutStoreIds()).ids : undefined);
  const parts = await acrossStores(() => args.fetch(window), { storeIds, abortOnError: true });
  const rows = dedupeById(parts.flatMap(p => p.value.rows));
  const key = (r: T): number => {
    const k = args.orderKey(r);
    return k instanceof Date ? k.getTime() : k;
  };
  const dir = args.desc === false ? 1 : -1;
  rows.sort((a, b) => dir * (key(a) - key(b)));
  return {
    rows: rows.slice(args.skip, args.skip + args.take),
    // `total` is the sum of the per-store counts (each store counted inside its own scope)
    total: parts.reduce((n, p) => n + p.value.total, 0),
  };
}

/** The ids of the stores a store admin owns (all stores for `undefined`). */
export async function ownedStoreIds(ownerId: string | undefined): Promise<string[] | undefined> {
  if (!ownerId) return undefined;
  // `stores` is under RLS (R-EBDA-005): read the owner's store ids AS that owner, through the
  // guarded definer (the acting user must be `ownerId` or a super_admin).
  return withUser(ownerId, () => definerOwnedStoreIds(ownerId));
}

/**
 * A cron "find the oldest N matching rows" sweep, across stores.
 *
 * Each store is asked for its own `take` oldest/newest rows (inside its own
 * tenant transaction); the rows are then merged, sorted by `orderKey` and cut to
 * the same global `take` the single query used to have.
 */
export async function sweepAcrossStores<T>(args: {
  /** One store's rows, inside that store's scope; `storeId` is the store being scanned. */
  fetch: (storeId: string) => Promise<T[]>;
  orderKey: (row: T) => Date | number;
  take: number;
  /** Newest first. Default: oldest first. */
  desc?: boolean;
  storeIds?: string[];
}): Promise<T[]> {
  const rows = dedupeById(
    await acrossStoresFlat(args.fetch, { storeIds: args.storeIds, abortOnError: true })
  );
  const key = (r: T): number => {
    const k = args.orderKey(r);
    return k instanceof Date ? k.getTime() : k;
  };
  const dir = args.desc ? -1 : 1;
  return rows.sort((a, b) => dir * (key(a) - key(b))).slice(0, args.take);
}
