/**
 * StoreDO: ONE SQLite Durable Object per store (Ruling INFRA-CF-1, Phase 0 spike).
 *
 * Reachable ONLY for a store listed in STORE_DO_ENABLED_IDS (default empty = nobody) AND a request
 * carrying `x-ebda-backend: do` (lib/store-backend.ts). Production storefront traffic never touches it.
 * Data layer: Drizzle on DO SQLite (Ruling INFRA-CF-2). Every money/stock section is one synchronous
 * `transactionSync`: no `await` between the stock read and the write.
 */
import { DurableObject } from 'cloudflare:workers';
import { handleStoreAdmin } from '../../../../../packages/cf-migrate/src/store-admin.mjs';
import * as schema from './schema';
import { makeDrizzle, listProducts, addCartItem, createOrder, StoreError, type Db } from './repo';
import { CORE_0001 } from './migrations';
import { statements } from './sql';
import { STORE_TABLES } from './tables';
import { countCustomerRows, eraseCustomerRows, exportCustomerRows } from '../erasure/store-do-sql';
import type { Subject } from '../erasure/types';
import {
  buildBackup,
  dumpTables,
  loadBackup,
  sha256Hex,
  backupKey,
  verifyWritten,
  type BackupManifest,
} from './backup';

export const MIGRATIONS: { id: string; sql: string }[] = [{ id: '0001_core', sql: CORE_0001 }];

export type Result<T> = { ok: true; data: T } | { ok: false; code: string; status: number };

function run<T>(fn: () => T): Result<T> {
  try {
    return { ok: true, data: fn() };
  } catch (e) {
    if (e instanceof StoreError) return { ok: false, code: e.code, status: e.status };
    throw e;
  }
}

/** The slice of an R2 bucket binding the backup uses (workers-types globals are not loaded here). */
export interface R2Like {
  put(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}
const DAY_MS = 24 * 60 * 60 * 1000;

export class StoreDO extends DurableObject<Record<string, unknown>> {
  readonly db: Db;

  constructor(ctx: ConstructorParameters<typeof DurableObject>[0], env: Record<string, unknown>) {
    super(ctx, env);
    this.db = makeDrizzle(ctx.storage); // once per DO lifetime: no per-request client
    void ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  /**
   * The cutover admin surface (__import/__verify/__seal/__status/__unseal/...). Reached ONLY through
   * cf/cutover.ts, which checks the CUTOVER_IMPORT_SECRET bearer before this DO sees the request.
   */
  async fetch(request: Request): Promise<Response> {
    return handleStoreAdmin(request, {
      sql: this.ctx.storage.sql as never,
      transactionSync: fn => this.ctx.storage.transactionSync(fn),
    });
  }

  private migrate(): void {
    const sqlx = this.ctx.storage.sql;
    sqlx.exec(
      'CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)'
    );
    const done = new Set(
      sqlx
        .exec('SELECT id FROM _migrations')
        .toArray()
        .map(r => r.id as string)
    );
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      this.ctx.storage.transactionSync(() => {
        for (const stmt of statements(m.sql)) sqlx.exec(stmt);
        sqlx.exec('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)', m.id, Date.now());
      });
    }
  }

  seed(rows: {
    store: typeof schema.stores.$inferInsert;
    products: (typeof schema.products.$inferInsert)[];
    variants?: (typeof schema.productVariants.$inferInsert)[];
  }): Result<{ products: number; variants: number }> {
    return run(() =>
      this.ctx.storage.transactionSync(() => {
        this.db.insert(schema.stores).values(rows.store).onConflictDoNothing().run();
        for (const p of rows.products)
          this.db
            .insert(schema.products)
            .values(p)
            .onConflictDoUpdate({ target: schema.products.id, set: { ...p, id: undefined } })
            .run();
        for (const v of rows.variants ?? [])
          this.db
            .insert(schema.productVariants)
            .values(v)
            .onConflictDoUpdate({ target: schema.productVariants.id, set: { ...v, id: undefined } })
            .run();
        return { products: rows.products.length, variants: rows.variants?.length ?? 0 };
      })
    );
  }

  listProducts(storeId: string, limit: number) {
    return run(() => listProducts(this.db, storeId, limit));
  }

  addCartItem(
    storeId: string,
    sessionId: string,
    productId: string,
    qty: number,
    variantId?: string
  ) {
    return run(() => addCartItem(this.db, storeId, sessionId, productId, qty, variantId));
  }

  createOrder(storeId: string, sessionId: string) {
    return run(() => createOrder(this.db, storeId, sessionId));
  }

  rowCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const t of STORE_TABLES)
      out[t] = this.ctx.storage.sql.exec(`SELECT count(*) AS n FROM ${t}`).one().n as number;
    return out;
  }

  /** Stock of a no-variant product (tests and the drill). */
  stock(productId: string): number {
    return this.ctx.storage.sql
      .exec('SELECT inventory AS n FROM products WHERE id = ?', productId)
      .one().n as number;
  }

  // ---- backup (nightly alarm) and restore drill ----
  /** Arm the nightly alarm if none is pending. Idempotent; called from the loader and after each alarm. */
  async ensureBackupAlarm(): Promise<number> {
    const cur = await this.ctx.storage.getAlarm();
    if (cur) return cur;
    const at = Date.now() + DAY_MS;
    await this.ctx.storage.setAlarm(at);
    return at;
  }

  private bucket(): R2Like | undefined {
    return this.env.STORE_BACKUPS as R2Like | undefined;
  }

  /** Export every table + manifest to R2 under store-do-backups/<store>/<yyyy-mm-dd>/. */
  async backupNow(storeId: string): Promise<BackupManifest> {
    const r2 = this.bucket();
    if (!r2) throw new Error('STORE_BACKUPS binding missing');
    const dump = dumpTables(this.ctx.storage.sql); // sync read: consistent snapshot
    const { manifest, files } = await buildBackup(storeId, dump);
    const day = manifest.takenAt.slice(0, 10);
    for (const [name, body] of Object.entries(files))
      await r2.put(backupKey(storeId, day, name), body);
    // The manifest goes last: a day folder without one is an incomplete backup and must be ignored.
    await r2.put(backupKey(storeId, day, 'manifest.json'), JSON.stringify(manifest, null, 2));
    // Read-back (rule N11): a backup that is not read back is not a backup.
    await verifyWritten(r2, storeId, day, manifest);
    return manifest;
  }

  async alarm(): Promise<void> {
    try {
      const storeId = this.ctx.storage.sql.exec('SELECT id FROM stores LIMIT 1').toArray()[0]
        ?.id as string | undefined;
      if (storeId) await this.backupNow(storeId);
    } finally {
      // Re-arm even when the export threw: a failed night must not stop the next one (alerting: a missing
      // manifest for yesterday is the signal, see docs/plans/2026-10-29-cf-phase0-go-no-go.md).
      await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
    }
  }

  /** Restore drill: load a backup (by day) from R2 into THIS (empty) DO and re-check counts + checksums. */
  async restoreFrom(
    sourceStoreId: string,
    day: string
  ): Promise<Result<Record<string, { rows: number; sha256: string; ok: boolean }>>> {
    try {
      return { ok: true, data: await this.restoreFromUnsafe(sourceStoreId, day) };
    } catch (e) {
      // Returned, not thrown: a refused restore is an answer, not a Durable Object fault.
      return { ok: false, code: (e as Error).message, status: 409 };
    }
  }

  private async restoreFromUnsafe(
    sourceStoreId: string,
    day: string
  ): Promise<Record<string, { rows: number; sha256: string; ok: boolean }>> {
    const r2 = this.bucket();
    if (!r2) throw new Error('STORE_BACKUPS binding missing');
    const m = await r2.get(backupKey(sourceStoreId, day, 'manifest.json'));
    if (!m) throw new Error('no manifest: incomplete or missing backup');
    const manifest = JSON.parse(await m.text()) as BackupManifest;
    const files: Record<string, string> = {};
    for (const t of STORE_TABLES) {
      const f = await r2.get(backupKey(sourceStoreId, day, `${t}.ndjson`));
      if (!f) throw new Error(`missing ${t}.ndjson`);
      files[`${t}.ndjson`] = await f.text();
      if ((await sha256Hex(files[`${t}.ndjson`])) !== manifest.tables[t].sha256)
        throw new Error(`${t}: file checksum differs from manifest`);
    }
    for (const t of STORE_TABLES)
      if (this.ctx.storage.sql.exec(`SELECT count(*) AS n FROM ${t}`).one().n !== 0)
        throw new Error('restore target must be empty');
    this.ctx.storage.transactionSync(() => loadBackup(this.ctx.storage.sql, files));
    // Re-export the restored DO with the same canonical serialization and compare to the manifest.
    const again = await buildBackup(sourceStoreId, dumpTables(this.ctx.storage.sql));
    const out: Record<string, { rows: number; sha256: string; ok: boolean }> = {};
    for (const t of STORE_TABLES) {
      const want = manifest.tables[t];
      const got = again.manifest.tables[t];
      out[t] = {
        rows: got.rows,
        sha256: got.sha256,
        ok: got.rows === want.rows && got.sha256 === want.sha256,
      };
    }
    return out;
  }

  // ---- PDPL export / erasure (G10; cf/erasure). Registry-driven, see cf/erasure/registry.ts ----
  /** Merchant: every table, whole. Customer: only the registry's customer-pii rows that match. */
  exportSubject(s: Subject): { tables: Record<string, Array<Record<string, unknown>>> } {
    if (s.kind === 'customer') return { tables: exportCustomerRows(this.ctx.storage.sql, s) };
    const tables: Record<string, Array<Record<string, unknown>>> = {};
    for (const t of STORE_TABLES)
      tables[t] = this.ctx.storage.sql.exec(`SELECT * FROM ${t} ORDER BY rowid`).toArray();
    return { tables };
  }

  /** Merchant: wipe the whole DO (rows, alarm). Customer: delete/scrub the registry rows that match. */
  async eraseSubject(s: Subject): Promise<{ erased: Record<string, number>; remaining: number }> {
    const sqlx = this.ctx.storage.sql;
    if (s.kind === 'customer') {
      const erased = this.ctx.storage.transactionSync(() => eraseCustomerRows(sqlx, s));
      return { erased, remaining: countCustomerRows(sqlx, s) };
    }
    const erased = this.rowCounts();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    const left = sqlx
      .exec(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
      )
      .one().n as number;
    return { erased, remaining: left };
  }

  /** PITR bookmark for "now" (SQLite-backed DOs, 30 days). Returned so the drill can record availability. */
  async pitrBookmark(): Promise<string> {
    const s = this.ctx.storage as unknown as { getCurrentBookmark(): Promise<string> };
    return s.getCurrentBookmark();
  }
}
