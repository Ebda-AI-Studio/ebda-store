/**
 * Per-store storage backend flag (Ruling INFRA-CF-1 task 2.4, Ruling CF-PLATFORM-1).
 *
 * D1 `ebda-platform` `stores.storage_backend` ('pg' | 'do') is the ONE switch. `backendFor` reads it on EVERY call.
 *
 * STALENESS CLASS: NEVER-stale (it decides where money and stock are written). There is deliberately NO cache layer
 * (no isolate memo, no KV, no edge copy) between this read and D1, so the flag writer (`scripts/cf/flip-backend.mjs`,
 * a single UPDATE on D1) has nothing to invalidate and the next request already sees the new value. A TTL would not
 * be a control here. If a cache is ever added it MUST be invalidated by every write path of the flag, in every layer.
 *
 * Fail closed: an unresolved store id is a 404 (never the first store); a D1 that cannot be read, or a flag value
 * that is not 'pg'/'do', is a 503 (never a guessed backend); a production Worker whose PLATFORM_DB binding is missing
 * is a 503. A store with NO row yet is on Postgres: the flip is an UPDATE of an existing row, so a store that was never
 * migrated into D1 cannot have been flipped.
 *
 * The Phase 0 spike gate (id in STORE_DO_ENABLED_IDS AND `x-ebda-backend: do`) survives ONLY where D1 is unbound in
 * Node / local / test runs; it is deleted with the flag at Phase 5. Never flag `qa-walk-store-1010`.
 */
import type { Request } from 'express';
import { cfBindings } from '../cf/bindings';
import { AppError } from '../middleware/error-handler';
import logger from './logger';

export type StoreBackend = 'do' | 'pg';

/** The slice of a D1 database this module uses (structural: the API does not compile against workers-types). */
export interface PlatformD1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): { first<T = Record<string, unknown>>(): Promise<T | null> };
    all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  };
}

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

/** Generic to the client; the cause is logged server-side only (structured field, control characters stripped). */
const unavailable = (why: string) => {
  logger.error(
    { cause: why.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300) },
    'store backend flag unreadable'
  );
  return new AppError(503, 'STORE_BACKEND_UNAVAILABLE', 'Store backend temporarily unavailable');
};

export async function backendFor(
  storeId: string,
  req: Pick<Request, 'headers'>
): Promise<StoreBackend> {
  if (typeof storeId !== 'string' || !storeId.trim())
    throw new AppError(404, 'STORE_NOT_FOUND', 'Store not found');
  const bound = cfBindings();
  const db = bound?.PLATFORM_DB as PlatformD1Like | undefined;
  if (!db) {
    // A deployed Worker must have D1; only Node / local / tests may use the spike gate.
    if (bound && process.env.NODE_ENV === 'production')
      throw new AppError(503, 'PLATFORM_DB_UNBOUND', 'Platform database is not bound');
    if (!enabledStoreIds().has(storeId)) return 'pg';
    return req.headers['x-ebda-backend'] === 'do' ? 'do' : 'pg';
  }
  let row: { storage_backend?: unknown } | null;
  try {
    row = await db
      .prepare('SELECT storage_backend FROM stores WHERE id = ?1')
      .bind(storeId)
      .first();
  } catch (err) {
    throw unavailable(err instanceof Error ? err.message : 'query failed');
  }
  if (!row) return 'pg';
  if (row.storage_backend === 'do' || row.storage_backend === 'pg') return row.storage_backend;
  throw unavailable('unknown storage_backend value');
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
  ): Promise<DoResult<{ orderId: string; orderNumber: number; total: number }>>;
  seed(rows: unknown): Promise<DoResult<{ products: number; variants: number }>>;
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
