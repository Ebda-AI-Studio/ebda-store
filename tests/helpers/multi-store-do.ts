/**
 * One StoreDO world PER STORE for node tests: each store id gets its own node:sqlite database with the real DO schema and the
 * real prisma-lite client (the production read/write path of a store's Durable Object). `repoByPath()` is the express
 * middleware that enters the repo scope of the store named in the URL (what `repoScope` + the store-backend flag do in
 * production), and `withStoreRepo` enters one store's scope (use it from a mocked `withStore`). A second store therefore never
 * sees the first store's rows: the isolation is the same one the DO gives (one database per store).
 */
import type { NextFunction, Request, Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import {
  bootstrapStoreRows,
  createDoClient,
  createPrismaLite,
  decodeRpc,
  encodeRpc,
  ensureIdempotencySchema,
  readStoreRecord,
  runReads,
  runWrites,
} from '@ebda-src/repo';
import { doStoreDelegate, withRepo } from '../../apps/api/src/lib/repo-factory';
import { META, openSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export interface DoStoreWorld {
  storeId: string;
  sqlite: DatabaseSync;
  repo: { storeId: string; backend: 'do'; db: never; writer: never };
  rows: (sql: string, ...p: unknown[]) => Record<string, unknown>[];
  /** The store's `store_profile` / `store_config` rows (what provisioning bootstraps); needed by any `db.store` read. */
  seedProfile: (
    identity: { name: string; slug: string; ownerId: string },
    fields?: Record<string, unknown>
  ) => void;
}

export class DoStores {
  private worlds = new Map<string, DoStoreWorld>();

  add(storeId: string, actorRole = 'store_admin'): DoStoreWorld {
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
    const world: DoStoreWorld = {
      storeId,
      sqlite,
      repo: { storeId, backend: 'do', db: withStoreDelegate(c as object) as never, writer: c },
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
    return w ? withRepo(w.repo as never, fn) : fn();
  }

  /** Express middleware: the repo scope of the store whose uuid appears in the URL. */
  repoByPath() {
    return (req: Request, _res: Response, next: NextFunction) => {
      const id = UUID.exec(req.originalUrl)?.[0]?.toLowerCase();
      const w = id ? this.worlds.get(id) : undefined;
      if (!w) return next();
      void withRepo(w.repo as never, async () => next());
    };
  }
}
