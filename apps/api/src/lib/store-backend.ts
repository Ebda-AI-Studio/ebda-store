/**
 * Per-store storage backend flag (Ruling INFRA-CF-1, hardened by Ruling CF-BACKEND-1).
 *
 * The backend of a store comes ONLY from server-side state: the D1 `stores.storage_backend` column (the one switch
 * `scripts/cf/flip-backend.mjs` writes). NOTHING in the request chooses it: a client header such as the Phase 0
 * `x-ebda-backend: do` is ignored (and stripped at the Worker edge), because letting a visitor move a store's money,
 * stock and writes onto the Durable Object while its real backend is Postgres is split-brain money state.
 *
 *   - D1 bound: the column decides. A store without a directory row does not exist: 404 STORE_NOT_FOUND (NEON-ZERO-1 N-14,
 *     the directory holds every store, so "unknown" is never "Postgres"); an unreadable or malformed flag is a 503
 *     (fail closed - a flagged store is never defaulted to pg on a read error).
 *   - D1 unbound (Node, unit tests, local dev): the `STORE_DO_ENABLED_IDS` env list decides - but only outside
 *     production. In production an unbound D1 with a listed store is a 503, never a silent fallback.
 *
 * Never flag `qa-walk-store-1010`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { cfBindings } from '../cf/bindings';
import { AppError } from '../middleware/error-handler';
import { isWorkers } from './runtime';

export type StoreBackend = 'do' | 'pg';

/** The slice of a D1 database `storageBackendCounts` uses (structural: the API does not compile against workers-types). */
export interface PlatformD1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): { first<T = Record<string, unknown>>(): Promise<T | null> };
    all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  };
}

/**
 * `/health` `storage_backend`: store counts per backend, read live from D1. `undefined` = no binding (local, field
 * omitted); `null` = D1 present but unreadable (reported as null, never as zero counts: unknown is not empty).
 */
export async function storageBackendCounts(
  db: PlatformD1Like | undefined
): Promise<Record<string, number> | null | undefined> {
  if (!db) return undefined;
  try {
    const { results } = await db
      .prepare('SELECT storage_backend, COUNT(*) AS n FROM stores GROUP BY storage_backend')
      .all<{ storage_backend: string; n: number }>();
    return Object.fromEntries(results.map(r => [r.storage_backend, Number(r.n)]));
  } catch {
    return null;
  }
}

/** Parse an env list. The ONLY production read of `STORE_DO_ENABLED_IDS` lives here (guard: tests/unit/backend-flag-single-source.test.ts). */
export function enabledStoreIds(
  raw: string | undefined = process.env.STORE_DO_ENABLED_IDS
): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  );
}

interface FlagD1 {
  prepare(sql: string): {
    bind(...v: unknown[]): { first<T = Record<string, unknown>>(): Promise<T | null> };
  };
}

interface ListD1 {
  prepare(sql: string): { all<T = Record<string, unknown>>(): Promise<{ results?: T[] }> };
}

const unavailable = () =>
  new AppError(503, 'STORE_BACKEND_UNAVAILABLE', 'Store backend flag is unavailable');

/**
 * The backend that serves `storeId`, from server-side state only (see the file header). Takes no request.
 * N-14b (Ruling NZ-D7) NOT done here: the D1 read doubles as the store-exists / soft-delete gate and Node, tests and local dev
 * still resolve `pg`; the constant-`do` collapse belongs to the N-16 dead-code PR together with the pg branches it removes.
 */
export async function backendFor(storeId: string): Promise<StoreBackend> {
  const d1 = (cfBindings() as { PLATFORM_DB?: FlagD1 } | undefined)?.PLATFORM_DB;
  if (!d1) {
    if (!enabledStoreIds().has(storeId)) return 'pg';
    if (process.env.NODE_ENV === 'production') throw unavailable();
    return 'do';
  }
  // Inside a `withBackendBatch` sweep the flag was read for every id in ONE query at its start; an id the batch did not
  // find falls through to the live read below, so an unknown store keeps today's 404 (never a guess).
  if (batchStorage.getStore()?.has(storeId))
    return backendFromRow({ storage_backend: batchStorage.getStore()!.get(storeId) });
  let row: { storage_backend?: unknown } | null;
  try {
    row = await d1
      .prepare('SELECT storage_backend FROM stores WHERE id = ?')
      .bind(storeId)
      .first<{ storage_backend?: unknown }>();
  } catch {
    throw unavailable();
  }
  if (!row) throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
  return backendFromRow(row);
}

function backendFromRow(row: { storage_backend?: unknown }): StoreBackend {
  // NEON-ZERO N-17 (Ruling NZ-D23): the Worker has no Postgres. A directory row still saying `pg` (only the soft-deleted QA
  // store) is gone for good: 410, a clean answer instead of a Prisma call that throws POSTGRES_REMOVED.
  if (row.storage_backend === 'pg' && isWorkers)
    throw new AppError(410, 'STORE_STORAGE_REMOVED', 'This store is no longer available');
  if (row.storage_backend === 'do' || row.storage_backend === 'pg') return row.storage_backend;
  throw unavailable();
}

interface BatchD1 {
  prepare(sql: string): {
    bind(...v: unknown[]): {
      all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
    };
  };
}

/**
 * storeId -> raw `storage_backend` for the ids that exist; read once per sweep, scoped to the sweep, never shared across runs.
 * Staleness class: BOUNDED-stale snapshot, window = one sweep run (seconds, bounded by the cron's lock TTL). A `flip-backend`
 * or soft-delete landing mid-run takes effect on the NEXT run (every run re-reads). Residual risk is pg<->do flips only: on
 * Workers a `pg` store already answers 410, so a stale `do`/`pg` view can at worst process one more sweep for that store.
 * Request paths never run inside a batch (ALS scope), so they keep the live per-call read.
 */
const batchStorage = new AsyncLocalStorage<Map<string, unknown>>();
const MAX_IDS_PER_READ = 90; // D1 allows 100 bound parameters per statement

/**
 * Run a cron sweep with every store's `storage_backend` read in as few D1 queries as possible (Sentry EBDA-API-Z: one
 * `SELECT storage_backend ... WHERE id = ?` per store per call). The map lives only for `fn`'s async context, so each run
 * re-reads the directory (the store-exists / soft-delete gate stays fresh; this is NOT a cross-request cache). Unreadable D1
 * or no binding -> `fn` runs unbatched, exactly as before.
 */
export async function withBackendBatch<T>(
  storeIds: readonly string[],
  fn: () => Promise<T>
): Promise<T> {
  const d1 = (cfBindings() as { PLATFORM_DB?: BatchD1 } | undefined)?.PLATFORM_DB;
  const ids = [...new Set(storeIds)].filter(Boolean);
  if (!d1 || ids.length === 0 || batchStorage.getStore()) return fn();
  const found = new Map<string, unknown>();
  try {
    for (let i = 0; i < ids.length; i += MAX_IDS_PER_READ) {
      const part = ids.slice(i, i + MAX_IDS_PER_READ);
      const rows =
        (
          await d1
            .prepare(
              `SELECT id, storage_backend FROM stores WHERE id IN (${part.map((_, j) => `?${j + 1}`).join(',')})`
            )
            .bind(...part)
            .all<{ id?: unknown; storage_backend?: unknown }>()
        ).results ?? [];
      for (const r of rows) if (typeof r.id === 'string') found.set(r.id, r.storage_backend);
    }
  } catch {
    return fn();
  }
  return batchStorage.run(found, fn);
}

/**
 * Every store served by its Durable Object, from the same source as `backendFor` (Ruling CF-BACKEND-2): the D1 column when
 * D1 is bound, the env list only where D1 is unbound (Node / tests / local dev; production with a listed store and no D1 is
 * a 503). Sweeps, the jobs guard and the webhook resolver use this - never the env list - so a store flipped only in D1 is
 * seen everywhere.
 */
export async function doStoreIdList(): Promise<string[]> {
  const d1 = (cfBindings() as { PLATFORM_DB?: ListD1 } | undefined)?.PLATFORM_DB;
  if (!d1) {
    const ids = [...enabledStoreIds()];
    if (ids.length > 0 && process.env.NODE_ENV === 'production') throw unavailable();
    return ids;
  }
  try {
    const rows = (
      await d1
        .prepare("SELECT id FROM stores WHERE storage_backend = 'do' AND deleted_at IS NULL")
        .all<{ id?: unknown }>()
    ).results;
    return (rows ?? []).map(r => r.id).filter((id): id is string => typeof id === 'string' && !!id);
  } catch {
    throw unavailable();
  }
}

/**
 * Is there at least one live store on `backend`? One indexed EXISTS ... LIMIT 1 (never the full scan of `doStoreIdList`), for the
 * per-webhook / per-callback "does the fleet contain X" question. D1 unbound: the env list for `do`, always true for `pg`.
 */
export async function hasStoresOnBackend(backend: StoreBackend): Promise<boolean> {
  const d1 = (cfBindings() as { PLATFORM_DB?: FlagD1 } | undefined)?.PLATFORM_DB;
  if (!d1) {
    if (backend === 'pg') return true;
    if (enabledStoreIds().size > 0 && process.env.NODE_ENV === 'production') throw unavailable();
    return enabledStoreIds().size > 0;
  }
  try {
    const row = await d1
      .prepare(
        'SELECT 1 AS one FROM stores WHERE storage_backend = ?1 AND deleted_at IS NULL LIMIT 1'
      )
      .bind(backend)
      .first<{ one?: unknown }>();
    return !!row;
  } catch {
    throw unavailable();
  }
}

export async function doStoreIdSet(): Promise<Set<string>> {
  return new Set(await doStoreIdList());
}

type DoResult<T> = { ok: true; data: T } | { ok: false; code: string; status: number };
interface StoreDoStub {
  listProducts(storeId: string, limit: number): Promise<DoResult<unknown[]>>;
  addCartItem(
    storeId: string,
    sessionId: string,
    productId: string,
    qty: number,
    variantId?: string
  ): Promise<DoResult<{ cartId: string }>>;
  createOrder(
    storeId: string,
    sessionId: string
  ): Promise<DoResult<{ orderId: string; orderNumber: string; total: number }>>;
  seed(rows: unknown): Promise<DoResult<{ products: number; variants: number }>>;
  /** N-18: first-time bootstrap of a store created on its DO (store_profile + store_config + default rows). Idempotent. */
  bootstrapStore(
    storeId: string,
    inputJson: string
  ): Promise<DoResult<{ profile: string[]; config: string[]; directoryOnly: string[] }>>;
  rowCounts(): Promise<Record<string, number>>;
  ensureBackupAlarm(): Promise<number>;
  backupNow(storeId: string): Promise<unknown>;
  restoreFrom(
    sourceStoreId: string,
    day: string
  ): Promise<DoResult<Record<string, { rows: number; sha256: string; ok: boolean }>>>;
  pitrBookmark(): Promise<string>;
  authOp(
    storeId: string,
    op: string,
    argsJson: string
  ): Promise<
    { ok: true; json: string } | { ok: false; code: string; status: number; message: string }
  >;
}

/** The StoreDO stub for a store. Throws when the binding is absent (Node / tests): never silently falls back. */
export function storeDo(storeId: string, instanceName: string = storeId): StoreDoStub {
  const ns = cfBindings()?.STORE_DO;
  if (!ns) throw new AppError(503, 'STORE_DO_UNAVAILABLE', 'Store Durable Object is not bound');
  return ns.get(ns.idFromName(instanceName)) as unknown as StoreDoStub;
}

/** Map a DO result to the API envelope; a domain failure becomes an AppError with the DO's status. */
export function unwrapDo<T>(r: DoResult<T>): T {
  if (r.ok) return r.data;
  throw new AppError(r.status, r.code, r.code);
}
