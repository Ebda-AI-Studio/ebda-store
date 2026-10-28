/**
 * Per-store data access factory (INFRA-CF-1 task 2.4, Ruling CF-REPO-1).
 *
 * `storeDb(storeId)` hands a service the READ client of the backend that serves that store:
 *   - 'pg' (the DEFAULT for every store): the same `prisma` proxy every service uses today, so a service that moves to
 *     `storeDb` behaves byte-for-byte as before (request transaction, tenant guard, RLS GUCs all unchanged);
 *   - 'do': a Prisma-shaped READ client for that store's Durable Object (packages/repo createDoClient), over the
 *     StoreDO `query` RPC.
 * The backend is chosen by `backendFor` (lib/store-backend.ts: the D1 `stores.storage_backend` flag). Nothing here
 * flips a store; with every flag at 'pg' this module changes no behaviour.
 *
 * FAIL CLOSED: an empty/unresolved store id is a 404 (never "the first store", never the default); a DO that is not bound
 * is a 503 (never a silent fall back to Postgres for a store whose flag says 'do').
 *
 * REQUEST SCOPE: `repoScope` (mounted once in app.ts) opens an AsyncLocalStorage scope per request so the flag is read
 * AT MOST ONCE per (request, store) and a service needs only the store id. STALENESS CLASS of that memo: NEVER-stale
 * data (it decides where money and stock live) cached for ONE REQUEST. Residual window = the request's own duration: a
 * flip happens while writes are frozen and the store sealed (docs/runbooks/cutover-cf.md), so a request that began before
 * the flip finishes on the backend it started on, which is also the only consistent choice mid-request. There is NO
 * cross-request cache, so the flag writer has nothing to invalidate. Outside a request (job, cron, script) every call
 * reads the flag afresh.
 *
 * ISOLATION: the DO client is built per store id and the DO itself refuses any other store (StoreDO.bind), so a client
 * for store A can never read store B's rows.
 *
 * WHAT IS NOT HERE (PR D): writes, raw SQL, `$queryRaw`, interactive `$transaction`, aggregate/groupBy, row locks. The type
 * `StoreReads` offers only the read operations prisma-lite answers, so a service that compiles against it cannot call
 * anything else on either backend.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { prisma, type AppPrismaClient } from '@ebda/database';
import { AppError } from '../middleware/error-handler';
import { backendFor, storeDo, type StoreBackend } from './store-backend';

type ReadOp =
  | 'findMany'
  | 'findFirst'
  | 'findUnique'
  | 'findFirstOrThrow'
  | 'findUniqueOrThrow'
  | 'count';

/** The read-only slice of every model delegate of the Prisma client: what prisma-lite answers on the StoreDO. */
export type StoreReads = {
  [K in keyof AppPrismaClient as AppPrismaClient[K] extends { findMany: unknown }
    ? K
    : never]: Pick<AppPrismaClient[K], Extract<keyof AppPrismaClient[K], ReadOp>>;
};

export interface StoreRepo {
  storeId: string;
  backend: StoreBackend;
  db: StoreReads;
}

type RequestLike = Pick<Request, 'headers'>;
interface Scope {
  req: RequestLike;
  repos: Map<string, Promise<StoreRepo>>;
}
const scopes = new AsyncLocalStorage<Scope>();
const NO_REQUEST: RequestLike = { headers: {} };

/** The StoreDO stub's read entry point (lib/store-backend.ts types the rest of the stub). */
interface QueryStub {
  query(
    storeId: string,
    queries: Array<{ model: string; op: string; args?: Record<string, unknown> }>
  ): Promise<
    { ok: true; json: string } | { ok: false; code: string; message: string; json?: string }
  >;
}

async function doReads(storeId: string): Promise<StoreReads> {
  const stub = storeDo(storeId) as unknown as QueryStub; // 503 here when the binding is absent
  // Dynamic: the Node build cannot resolve the @ebda-src alias (apps/api/src/cf/repo-modules.d.ts); only a Worker with a
  // bound StoreDO ever reaches this line.
  const { createDoClient } = await import('@ebda-src/repo');
  return createDoClient(queries => stub.query(storeId, queries as never)) as unknown as StoreReads;
}

async function resolve(storeId: string, req: RequestLike): Promise<StoreRepo> {
  const backend = await Promise.resolve(backendFor(storeId, req as Request)); // async once the D1 flag lands
  if (backend === 'do') return { storeId, backend, db: await doReads(storeId) };
  return { storeId, backend: 'pg', db: prisma as unknown as StoreReads };
}

/** The repo for a store: pg (default) or its Durable Object, per the store's flag. Memoised per request. */
export function storeRepo(storeId: string): Promise<StoreRepo> {
  if (typeof storeId !== 'string' || !storeId.trim())
    return Promise.reject(new AppError(404, 'STORE_NOT_FOUND', 'Store not found'));
  const scope = scopes.getStore();
  if (!scope) return resolve(storeId, NO_REQUEST);
  let p = scope.repos.get(storeId);
  if (!p) {
    p = resolve(storeId, scope.req);
    scope.repos.set(storeId, p);
    // a failed resolution must not be remembered as the answer
    p.catch(() => scope.repos.delete(storeId));
  }
  return p;
}

/** The read client services use: `const db = await storeDb(storeId); db.blogPost.findMany(...)`. */
export async function storeDb(storeId: string): Promise<StoreReads> {
  return (await storeRepo(storeId)).db;
}

/** Express middleware: one repo scope per request. Cheap (no I/O); the flag is read lazily by the first `storeDb`. */
export function repoScope(req: Request, _res: Response, next: NextFunction): void {
  scopes.run({ req, repos: new Map() }, next);
}

/** Run `fn` in a repo scope with `repo` pre-resolved for its store (contract tests, diagnostics). */
export function withRepo<T>(repo: StoreRepo, fn: () => T, req: RequestLike = NO_REQUEST): T {
  return scopes.run({ req, repos: new Map([[repo.storeId, Promise.resolve(repo)]]) }, fn);
}
