/**
 * Per-store storage backend flag (Ruling INFRA-CF-1, hardened by Ruling CF-BACKEND-1).
 *
 * The backend of a store comes ONLY from server-side state: the D1 `stores.storage_backend` column (the one switch
 * `scripts/cf/flip-backend.mjs` writes). NOTHING in the request chooses it: a client header such as the Phase 0
 * `x-ebda-backend: do` is ignored (and stripped at the Worker edge), because letting a visitor move a store's money,
 * stock and writes onto the Durable Object while its real backend is Postgres is split-brain money state.
 *
 *   - D1 bound: the column decides. A store without a directory row is not flagged ('pg'); an unreadable or malformed
 *     flag is a 503 (fail closed - a flagged store is never defaulted to pg on a read error).
 *   - D1 unbound (Node, unit tests, local dev): the `STORE_DO_ENABLED_IDS` env list decides - but only outside
 *     production. In production an unbound D1 with a listed store is a 503, never a silent fallback.
 *
 * Never flag `qa-walk-store-1010`.
 */
import { cfBindings } from '../cf/bindings';
import { AppError } from '../middleware/error-handler';

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

/** The backend that serves `storeId`, from server-side state only (see the file header). Takes no request. */
export async function backendFor(storeId: string): Promise<StoreBackend> {
  const d1 = (cfBindings() as { PLATFORM_DB?: FlagD1 } | undefined)?.PLATFORM_DB;
  if (!d1) {
    if (!enabledStoreIds().has(storeId)) return 'pg';
    if (process.env.NODE_ENV === 'production') throw unavailable();
    return 'do';
  }
  let row: { storage_backend?: unknown } | null;
  try {
    row = await d1
      .prepare('SELECT storage_backend FROM stores WHERE id = ?')
      .bind(storeId)
      .first<{ storage_backend?: unknown }>();
  } catch {
    throw unavailable();
  }
  if (!row) return 'pg';
  if (row.storage_backend === 'do' || row.storage_backend === 'pg') return row.storage_backend;
  throw unavailable();
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
