/**
 * Per-store storage backend flag (Ruling INFRA-CF-1, Phase 0 spike).
 *
 * `backendFor` returns 'do' ONLY when (a) the store id is listed in STORE_DO_ENABLED_IDS (wrangler var,
 * default EMPTY = nobody) AND (b) the request opts in with `x-ebda-backend: do`. Anything else is 'pg',
 * the unchanged production path. (b) keeps the public demo storefront on Postgres while the spike is
 * measured; it is deleted with the flag at Phase 5. Never flag `qa-walk-store-1010`.
 */
import type { Request } from 'express';
import { cfBindings } from '../cf/bindings';
import { AppError } from '../middleware/error-handler';

export type StoreBackend = 'do' | 'pg';

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

export function backendFor(storeId: string, req: Pick<Request, 'headers'>): StoreBackend {
  if (!enabledStoreIds().has(storeId)) return 'pg';
  return req.headers['x-ebda-backend'] === 'do' ? 'do' : 'pg';
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
