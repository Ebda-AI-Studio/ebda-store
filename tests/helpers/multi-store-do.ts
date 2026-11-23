/**
 * One StoreDO world PER STORE for node tests: each store id gets its own node:sqlite database with the real DO schema and the
 * real prisma-lite client (the production read/write path of a store's Durable Object). `repoByPath()` is the express
 * middleware that enters the repo scope of the store named in the URL (what `repoScope` + the store-backend flag do in
 * production), and `withStoreRepo` enters one store's scope (use it from a mocked `withStore`). A second store therefore never
 * sees the first store's rows: the isolation is the same one the DO gives (one database per store).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import {
  answerMoneyOp,
  answerStockOp,
  bootstrapStoreRows,
  createDoClient,
  createPrismaLite,
  decodeRpc,
  encodeRpc,
  ensureIdempotencySchema,
  ensureMoneyOpsSchema,
  ensureStockOpsSchema,
  ensurePaymentSchema,
  readStoreRecord,
  runReads,
  runWrites,
} from '@ebda-src/repo';
import { AppError } from '../../apps/api/src/middleware/error-handler';
import {
  doStoreDelegate,
  makeMoneyClient,
  makeStockClient,
  withRepo,
} from '../../apps/api/src/lib/repo-factory';
import { META, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { nodeSyncSql } from '../../packages/repo/test/node-sync-sql';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export interface DoStoreWorld {
  storeId: string;
  sqlite: DatabaseSync;
  repo: { storeId: string; backend: 'do'; db: never; writer: never; money?: never; stock?: never };
  /** Present when the world was added with `{ money: true }`: the real money ops (orders, payments) on this store's DO. */
  money?: ReturnType<typeof makeMoneyClient>;
  rows: (sql: string, ...p: unknown[]) => Record<string, unknown>[];
  /** The store's `store_profile` / `store_config` rows (what provisioning bootstraps); needed by any `db.store` read. */
  seedProfile: (
    identity: { name: string; slug: string; ownerId: string },
    fields?: Record<string, unknown>
  ) => void;
}

export class DoStores {
  private worlds = new Map<string, DoStoreWorld>();
  private current = new AsyncLocalStorage<string>();

  /** The store whose scope the caller is in (what `currentStoreId()` answers in production). */
  currentStoreId(): string | undefined {
    return this.current.getStore();
  }

  add(storeId: string, opts: { money?: boolean; actorRole?: string } = {}): DoStoreWorld {
    const actorRole = opts.actorRole ?? 'store_admin';
    const sqlite = openSqlite();
    const sql = nodeSqlRunner(sqlite);
    ensureIdempotencySchema(sql);
    const lite = createPrismaLite(META as never, sql, 'store-do', { storeId }) as never;
    const c = createDoClient(
      q => runReads(lite, q),
      m => runWrites(lite, sql, { ...m, actorRole })
    ) as never;
    // `db.store` is the REAL split-aware delegate of repo-factory (the DO tables have no `Store`), fed by the DO's own record read.
    const stub = {
      storeRecord: async (id: string, fields?: string[]) => {
        const r = readStoreRecord(sql, META as never, id, fields);
        if (!r) return { ok: false as const, code: 'STORE_NOT_FOUND' };
        return {
          ok: true as const,
          data: { json: encodeRpc(r.record), missing: r.missing },
        };
      },
    };
    const storeDelegate = doStoreDelegate(storeId, stub as never, decodeRpc as never);
    const withStoreDelegate = (base: object) =>
      new Proxy(base, {
        get: (t, prop, recv) => (prop === 'store' ? storeDelegate : Reflect.get(t, prop, recv)),
      });
    let money: ReturnType<typeof makeMoneyClient> | undefined;
    let stock: ReturnType<typeof makeStockClient> | undefined;
    if (opts.money) {
      const sync = nodeSyncSql(sqlite);
      ensureMoneyOpsSchema(sync);
      ensurePaymentSchema(sync);
      ensureStockOpsSchema(sync);
      stock = makeStockClient(async (op, args, key) => {
        const r = answerStockOp(sync, storeId, op, encodeRpc(args), key);
        if (!r.ok) throw new AppError(r.status, r.code, r.message);
        return decodeRpc(r.json);
      });
      money = makeMoneyClient(async (op, args, key) => {
        const r = answerMoneyOp(sync, storeId, op, encodeRpc(args), key);
        if (!r.ok) throw new AppError(r.status, r.code, r.message);
        return decodeRpc(r.json);
      });
    }
    const world: DoStoreWorld = {
      storeId,
      sqlite,
      money,
      repo: {
        storeId,
        backend: 'do',
        db: withStoreDelegate(c as object) as never,
        writer: c,
        ...(money ? { money: money as never, stock: stock as never } : {}),
      },
      seedProfile: (identity, fields = {}) => {
        bootstrapStoreRows(sql, META as never, storeId, { identity, fields });
      },
      rows: (q, ...p) => sqlite.prepare(q).all(...(p as never[])) as Record<string, unknown>[],
    };
    this.worlds.set(storeId, world);
    return world;
  }

  get(storeId: string): DoStoreWorld {
    const w = this.worlds.get(storeId);
    if (!w) throw new Error(`no DO world for store ${storeId}`);
    return w;
  }

  clear(): void {
    this.worlds.clear();
  }

  /** Run `fn` in the repo scope of `storeId`; with no world for it, run `fn` unscoped. */
  withStoreRepo<T>(storeId: string, fn: () => T): T {
    const w = this.worlds.get(storeId);
    return w ? this.current.run(storeId, () => withRepo(w.repo as never, fn)) : fn();
  }

  /** Express middleware: the repo scope of the store whose uuid appears in the URL. */
  repoByPath() {
    return (req: Request, _res: Response, next: NextFunction) => {
      const id = UUID.exec(req.originalUrl)?.[0]?.toLowerCase();
      const w = id ? this.worlds.get(id) : undefined;
      if (!w) return next();
      void this.current.run(w.storeId, () => withRepo(w.repo as never, async () => next()));
    };
  }
}
