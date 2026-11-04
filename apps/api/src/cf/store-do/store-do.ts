/**
 * StoreDO: ONE SQLite Durable Object per store (Ruling INFRA-CF-1, Phase 0 spike).
 *
 * Reachable ONLY for a store whose server-side flag says 'do' (D1 stores.storage_backend, lib/store-backend.ts; Ruling
 * CF-BACKEND-1). No request header selects it.
 * Data layer: Drizzle on DO SQLite (Ruling INFRA-CF-2). Every money/stock section is one synchronous
 * `transactionSync`: no `await` between the stock read and the write.
 */
/**
 * StoreDO: ONE SQLite Durable Object per store (Ruling INFRA-CF-1, CF-DO-SCHEMA-1).
 *
 * The DO carries the FULL generated cf-schema (packages/cf-schema), versioned in `_migrations` and applied
 * idempotently on start (`runMigrations`). It is reachable only for a store whose D1 flag says `do`
 * (lib/store-backend.ts); no flag is on by default, so production traffic never touches it.
 *
 * Store isolation has two layers: the namespace routes a store id to its own instance (`idFromName(storeId)`), and the
 * instance BINDS to the first store id it serves and refuses any other (`bind`): a routing bug cannot read or write
 * another store's rows, because there are none in this instance.
 *
 * Every money/stock section is one synchronous `transactionSync`: no `await` between the stock read and the write.
 * Reads from the API Worker arrive as prisma-lite queries over `query()`; the non-money catalogue/content WRITES arrive
 * over `mutate()` (PR D1): one atomic transaction per call, optionally idempotent, allow-listed models only. Money, stock
 * and lock paths are not here (PR D2).
 */
import { DurableObject } from 'cloudflare:workers';
import { handleStoreAdmin } from '../../../../../packages/cf-migrate/src/store-admin.mjs';
import {
  createPrismaLite,
  doSqlRunner,
  doSyncSql,
  answerStockOp,
  answerMoneyOp,
  ensureMoneyOpsSchema,
  type MoneyAnswer,
  applyStoreSettings,
  readStoreRecord,
  encodeRpc,
  decodeRpc,
  ensureStockOpsSchema,
  type StockAnswer,
  ensureIdempotencySchema,
  ensurePaymentSchema,
  scrubReceiptsForOrders,
  moneyInFlightOnDo,
  isStoreClosed,
  closeStore,
  closeIfNoMoneyInFlight,
  reopenAfterFailedDelete,
  type CloseResult,
  type DoMoneyInFlight,
  ensureSearchIndex,
  purgeErasureLedger,
  MoneyError,
  runReads,
  runWrites,
  type DoMutation,
  type DoQuery,
  type DoQueryResult,
  type Meta,
  type SyncSql,
} from '@ebda-src/repo';
import * as repo from './repo';
import { StoreError } from './repo';
import { runMigrations, SCHEMA_VERSION } from './migrations';
import { exportOrder, storeTables } from './tables';
import {
  countCustomerRows,
  eraseCustomerRows,
  exportCustomerRows,
  matchedIds,
} from '../erasure/store-do-sql';
import { unclassifiedTables } from '../erasure/registry';
import type { Subject } from '../erasure/types';
import { eraseMerchantAtomically } from '../erasure/merchant-anonymise';
import {
  buildBackup,
  dumpTables,
  loadBackup,
  sha256Hex,
  backupKey,
  verifyWritten,
  type BackupManifest,
} from './backup';

export type Result<T> = { ok: true; data: T } | { ok: false; code: string; status: number };

function run<T>(fn: () => T): Result<T> {
  try {
    return { ok: true, data: fn() };
  } catch (e) {
    if (e instanceof StoreError) return { ok: false, code: e.code, status: e.status };
    if (e instanceof MoneyError) return { ok: false, code: e.code, status: e.status };
    if (e instanceof StoreMismatch) return { ok: false, code: 'STORE_MISMATCH', status: 403 };
    throw e;
  }
}

/** The slice of an R2 bucket binding the backup uses (workers-types globals are not loaded here). */
export interface R2Like {
  put(key: string, value: string): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}
const DAY_MS = 24 * 60 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class StoreDO extends DurableObject<Record<string, unknown>> {
  private readonly sync: SyncSql;
  private liteClient?: Record<string, unknown>;
  private boundStore?: string;

  constructor(ctx: ConstructorParameters<typeof DurableObject>[0], env: Record<string, unknown>) {
    super(ctx, env);
    this.sync = doSyncSql(ctx.storage);
    // Schema first, then the derived-state bootstrap (search index + triggers, payment claims). All idempotent.
    void ctx.blockConcurrencyWhile(async () => {
      runMigrations(ctx.storage);
      ctx.storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS _identity (k TEXT PRIMARY KEY, v TEXT NOT NULL)'
      );
      ensureSearchIndex(this.sync);
      ensurePaymentSchema(this.sync);
      ensureIdempotencySchema(doSqlRunner(ctx.storage));
      ensureStockOpsSchema(this.sync);
      ensureMoneyOpsSchema(this.sync);
    });
  }

  /**
   * The cutover admin surface (__import/__verify/__seal/__status/__unseal/...). Reached ONLY through
   * cf/cutover.ts, which checks the CUTOVER_IMPORT_SECRET bearer before this DO sees the request.
   */
  async fetch(request: Request): Promise<Response> {
    // A closed store's data is a retained legal record: the cutover surface may not import into it or WIPE it (__unseal).
    if (
      isStoreClosed(this.sync) &&
      /\/__(import|unseal|analytics)\b/.test(new URL(request.url).pathname)
    )
      return new Response(JSON.stringify({ ok: false, code: 'STORE_CLOSED' }), {
        status: 423,
        headers: { 'content-type': 'application/json' },
      });
    // Ruling NZ-AN-1: the per-store analytics copy. Three named ops only, never a free op name; bound to the store in the URL.
    const copy = /^\/cutover\/stores\/([^/]+)\/__analytics$/.exec(new URL(request.url).pathname);
    if (copy) return this.analyticsCopy(copy[1], request);
    return handleStoreAdmin(request, {
      sql: this.ctx.storage.sql as never,
      transactionSync: fn => this.ctx.storage.transactionSync(fn),
    });
  }

  /** `__analytics`: {op, args} for analyticsImportStatus / analyticsImport / analyticsImportFinish (bearer-checked in cf/cutover.ts). */
  private async analyticsCopy(storeId: string, request: Request): Promise<Response> {
    const reply = (body: unknown, status: number) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    let body: { op?: unknown; args?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return reply({ ok: false, code: 'BAD_JSON' }, 400);
    }
    const ALLOWED = [
      'analyticsImportStatus',
      'analyticsImport',
      'analyticsImportFinish',
      'analyticsImportReset',
    ];
    if (typeof body.op !== 'string' || !ALLOWED.includes(body.op))
      return reply({ ok: false, code: 'OP_NOT_ALLOWED' }, 400);
    try {
      this.bind(storeId);
    } catch {
      return reply({ ok: false, code: 'STORE_MISMATCH' }, 403);
    }
    const a = answerMoneyOp(this.sync, storeId, body.op, JSON.stringify(body.args ?? {}));
    return reply(a, a.ok ? 200 : (a.status ?? 400));
  }

  /** Schema version this instance runs (the id of the last applied migration). */
  schemaVersion(): { current: string; applied: string[] } {
    const applied = this.ctx.storage.sql
      .exec('SELECT id FROM _migrations ORDER BY applied_at, id')
      .toArray()
      .map(r => r.id as string);
    return { current: SCHEMA_VERSION, applied };
  }

  /**
   * Bind this instance to its store, once. Every entry point that names a store calls this first: a second, different
   * store id is refused (`STORE_MISMATCH`), whatever routed it here.
   */
  private bind(storeId: string): void {
    if (typeof storeId !== 'string' || !ID_RE.test(storeId))
      throw new StoreError('PRODUCT_NOT_FOUND', 404);
    if (this.boundStore === storeId) return;
    const row = this.ctx.storage.sql
      .exec("SELECT v FROM _identity WHERE k = 'store_id'")
      .toArray()[0];
    if (row && row.v !== storeId) throw new StoreMismatch();
    if (!row)
      this.ctx.storage.sql.exec("INSERT INTO _identity (k, v) VALUES ('store_id', ?)", storeId);
    this.boundStore = storeId;
  }

  /** The store this instance serves, or undefined before its first use. */
  boundStoreId(): string | undefined {
    const row = this.ctx.storage.sql
      .exec("SELECT v FROM _identity WHERE k = 'store_id'")
      .toArray()[0];
    return row ? (row.v as string) : undefined;
  }

  private async lite(storeId: string): Promise<Record<string, unknown>> {
    this.bind(storeId);
    if (!this.liteClient) {
      // Lazy: the 550 KB model metadata is parsed only by an instance that serves a prisma-lite read.
      const meta = (await import('@ebda-src/prisma-meta')).default as unknown as Meta;
      this.liteClient = createPrismaLite(meta, doSqlRunner(this.ctx.storage), 'store-do', {
        storeId,
      }) as unknown as Record<string, unknown>;
    }
    return this.liteClient;
  }

  /**
   * prisma-lite reads for the API Worker (lib/repo-factory.ts). READ OPS ONLY: runReads refuses anything else.
   * Returns, never throws: a refused store or a failed query is an answer.
   */
  async query(storeId: string, queries: DoQuery[]): Promise<DoQueryResult> {
    try {
      return await runReads(await this.lite(storeId), queries);
    } catch (e) {
      if (e instanceof StoreMismatch)
        return { ok: false, code: 'STORE_MISMATCH', message: e.message };
      throw e;
    }
  }

  /** A closed store (Ruling NZ-D15) refuses every write; reads, exports and backups keep working. Nothing is ever deleted. */
  private closedOr<T>(answer: T): T | null {
    return isStoreClosed(this.sync) ? answer : null;
  }

  /** Writes call this first; a closed store is a 410 answer (inside `run`, a StoreError). */
  private assertOpen(): void {
    if (isStoreClosed(this.sync)) throw new StoreError('STORE_CLOSED', 410);
  }

  /** ATOMIC money gate + close in one DO call (Ruling NZ-D17): {closed, token} or {refused, counts}. Deletes nothing. */
  closeIfNoMoneyInFlight(storeId: string): Result<CloseResult> {
    return run(() => {
      this.bind(storeId);
      return closeIfNoMoneyInFlight(this.sync);
    });
  }

  /** Compensating rollback of a close that this delete made, when the delete then failed (Ruling NZ-D17). */
  reopenAfterFailedDelete(storeId: string, token: string): Result<{ reopened: boolean }> {
    return run(() => {
      this.bind(storeId);
      return reopenAfterFailedDelete(this.sync, token);
    });
  }

  /**
   * Catalogue/content writes for the API Worker (lib/repo-factory.ts `storeWriter`). ONE atomic transaction per call;
   * `m.key` makes a retry return the first run's result. Refuses (as an answer, never a throw) a model that is not on the
   * D1 allow-list, a stock-column write, another store's id, and anything runWrites does not know.
   */
  async mutate(storeId: string, m: DoMutation): Promise<DoQueryResult> {
    try {
      this.bind(storeId);
      const closed = this.closedOr({
        ok: false as const,
        code: 'STORE_CLOSED',
        status: 410,
        message: 'store is closed',
      });
      if (closed) return closed;
      return await runWrites(await this.lite(storeId), doSqlRunner(this.ctx.storage), m);
    } catch (e) {
      if (e instanceof StoreMismatch)
        return { ok: false, code: 'STORE_MISMATCH', message: e.message };
      throw e;
    }
  }

  /**
   * Stock and inventory operations (Ruling CF-STOCK-1): ONE named operation = ONE `transactionSync` section, the
   * single-threaded replacement for the Postgres row locks. `argsJson` is the wire-encoded argument object; `key` makes a
   * retry return the first run's result. A refusal is an ANSWER, never a throw.
   */
  stockOp(storeId: string, op: string, argsJson: string, key?: string): StockAnswer {
    try {
      this.bind(storeId);
    } catch (e) {
      if (e instanceof StoreMismatch)
        return { ok: false, code: 'STORE_MISMATCH', status: 403, message: e.message };
      return { ok: false, code: 'STORE_NOT_FOUND', status: 404, message: 'store not found' };
    }
    const closed = this.closedOr({
      ok: false as const,
      code: 'STORE_CLOSED',
      status: 410,
      message: 'store is closed',
    });
    if (closed) return closed;
    return answerStockOp(this.sync, storeId, op, argsJson, key);
  }

  /**
   * Money operations (Ruling CF-MONEY-1): the same contract as `stockOp` (one named operation = one `transactionSync`
   * section, optional idempotency key, a refusal is an ANSWER) for the money paths moved in PR D2b.
   */
  moneyOp(storeId: string, op: string, argsJson: string, key?: string): MoneyAnswer {
    try {
      this.bind(storeId);
    } catch (e) {
      if (e instanceof StoreMismatch)
        return { ok: false, code: 'STORE_MISMATCH', status: 403, message: e.message };
      return { ok: false, code: 'STORE_NOT_FOUND', status: 404, message: 'store not found' };
    }
    const closed = this.closedOr({
      ok: false as const,
      code: 'STORE_CLOSED',
      status: 410,
      message: 'store is closed',
    });
    if (closed) return closed;
    return answerMoneyOp(this.sync, storeId, op, argsJson, key);
  }

  /**
   * The settings copy (Ruling CF-WRITES-2): the API writes the authoritative `Store` row first, then sends the changed
   * fields here as an RPC JSON string. Applied to `store_profile` / `store_config`; D1-only fields are reported, not stored.
   */
  async applySettings(
    storeId: string,
    fieldsJson: string
  ): Promise<Result<{ profile: string[]; config: string[]; directoryOnly: string[] }>> {
    try {
      this.bind(storeId);
      if (isStoreClosed(this.sync)) return { ok: false, code: 'STORE_CLOSED', status: 410 };
      const meta = (await import('@ebda-src/prisma-meta')).default as unknown as Meta;
      const fields = decodeRpc<Record<string, unknown>>(fieldsJson);
      return {
        ok: true,
        data: applyStoreSettings(doSqlRunner(this.ctx.storage), meta, storeId, fields),
      };
    } catch (e) {
      if (e instanceof StoreMismatch) return { ok: false, code: 'STORE_MISMATCH', status: 403 };
      const err = e as { code?: string };
      return { ok: false, code: err.code ?? 'SETTINGS_REFUSED', status: 409 };
    }
  }

  /**
   * The Store record for the API Worker (NEON-ZERO-1): profile + config as Prisma `Store` fields, wire-encoded. ONE
   * call per request (NEON-SCALE-1 rule 9); a refusal is an ANSWER. `missing` lists D1-only fields the caller reads from D1.
   */
  async storeRecord(
    storeId: string,
    fields?: string[]
  ): Promise<Result<{ json: string; missing: string[] }>> {
    try {
      this.bind(storeId);
      const meta = (await import('@ebda-src/prisma-meta')).default as unknown as Meta;
      const out = readStoreRecord(doSqlRunner(this.ctx.storage), meta, storeId, fields);
      if (!out) return { ok: false, code: 'STORE_NOT_FOUND', status: 404 };
      return { ok: true, data: { json: encodeRpc(out.record), missing: out.missing } };
    } catch (e) {
      if (e instanceof StoreMismatch) return { ok: false, code: 'STORE_MISMATCH', status: 403 };
      return { ok: false, code: 'STORE_RECORD_REFUSED', status: 400 };
    }
  }

  seed(rows: repo.SeedRows): Result<{ products: number; variants: number }> {
    return run(() => {
      const id = rows.store?.id ?? rows.products[0]?.storeId;
      if (!id) throw new StoreError('PRODUCT_NOT_FOUND', 404);
      this.bind(id);
      this.assertOpen();
      for (const p of rows.products) if (p.storeId !== id) throw new StoreMismatch();
      return repo.seed(this.sync, rows);
    });
  }

  listProducts(storeId: string, limit: number) {
    return run(() => {
      this.bind(storeId);
      return repo.listProducts(this.sync, storeId, limit);
    });
  }

  addCartItem(
    storeId: string,
    sessionId: string,
    productId: string,
    qty: number,
    variantId?: string
  ) {
    return run(() => {
      this.bind(storeId);
      this.assertOpen();
      return repo.addCartItem(this.sync, storeId, sessionId, productId, qty, variantId);
    });
  }

  createOrder(storeId: string, sessionId: string) {
    return run(() => {
      this.bind(storeId);
      this.assertOpen();
      return repo.createOrder(this.sync, storeId, sessionId);
    });
  }

  rowCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const t of storeTables(this.ctx.storage.sql))
      out[t] = this.ctx.storage.sql.exec(`SELECT count(*) AS n FROM "${t}"`).one().n as number;
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
    this.bind(storeId);
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
      // The saved scope of a half-finished shopper erasure never outlives its TTL (Ruling CF-R6A-3).
      try {
        purgeErasureLedger(this.sync);
      } catch (err) {
        console.error('erasure ledger purge failed', err);
      }
      const storeId = this.boundStoreId();
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
      this.bind(sourceStoreId); // the restored rows carry the source store's id: this instance now serves that store
      if (isStoreClosed(this.sync)) return { ok: false, code: 'STORE_CLOSED', status: 410 };
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
    // The manifest, not this DO's current schema, says which tables the backup holds; a table the target lacks fails.
    const tables = Object.keys(manifest.tables);
    const live = new Set(storeTables(this.ctx.storage.sql));
    const missing = tables.filter(t => !live.has(t));
    if (missing.length) throw new Error(`restore target has no table ${missing[0]}`);
    const files: Record<string, string> = {};
    for (const t of tables) {
      const f = await r2.get(backupKey(sourceStoreId, day, `${t}.ndjson`));
      if (!f) throw new Error(`missing ${t}.ndjson`);
      files[`${t}.ndjson`] = await f.text();
      if ((await sha256Hex(files[`${t}.ndjson`])) !== manifest.tables[t].sha256)
        throw new Error(`${t}: file checksum differs from manifest`);
    }
    for (const t of live)
      if (this.ctx.storage.sql.exec(`SELECT count(*) AS n FROM "${t}"`).one().n !== 0)
        throw new Error('restore target must be empty');
    this.ctx.storage.transactionSync(() => loadBackup(this.ctx.storage.sql, files, tables));
    // Re-export the restored DO with the same canonical serialization and compare to the manifest.
    const again = await buildBackup(sourceStoreId, dumpTables(this.ctx.storage.sql));
    const out: Record<string, { rows: number; sha256: string; ok: boolean }> = {};
    for (const t of tables) {
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
  /** Customer subjects FAIL CLOSED until the registry classifies every table of the live schema (see registry.ts). */
  private assertRegistryCoversSchema(): void {
    const gap = unclassifiedTables(storeTables(this.ctx.storage.sql));
    if (gap.length)
      throw new Error(
        `ERASURE_REGISTRY_INCOMPLETE: ${gap.length} StoreDO tables have no erasure entry (first: ${gap[0]})`
      );
  }

  /** Merchant: every table, whole. Customer: only the registry's customer-pii rows that match. */
  exportSubject(s: Subject): { tables: Record<string, Array<Record<string, unknown>>> } {
    const sqlx = this.ctx.storage.sql;
    if (s.kind === 'customer') {
      this.assertRegistryCoversSchema();
      return { tables: exportCustomerRows(sqlx, s) };
    }
    const tables: Record<string, Array<Record<string, unknown>>> = {};
    for (const t of storeTables(sqlx))
      tables[t] = sqlx.exec(`SELECT * FROM "${t}" ORDER BY ${exportOrder(sqlx, t)}`).toArray();
    return { tables };
  }

  /** READ-ONLY money-in-flight gate for the all-or-nothing merchant erasure preflight (Ruling NZ-D20). Writes and closes nothing. */
  async moneyInFlight(): Promise<Record<string, number>> {
    return moneyInFlightOnDo(this.sync) as unknown as Record<string, number>;
  }

  /** Merchant: wipe the whole DO (rows, alarm). Customer: delete/scrub the registry rows that match. */
  async eraseSubject(s: Subject): Promise<{
    erased: Record<string, number>;
    remaining: number;
    refused?: Record<string, number>;
  }> {
    const sqlx = this.ctx.storage.sql;
    if (s.kind === 'customer') {
      this.assertRegistryCoversSchema();
      const erased = this.ctx.storage.transactionSync(() => {
        // InstaPay receipts of the subject's orders (Ruling INSTAPAY-DO-1): the personal fields go AND the rows are marked so the
        // retention sweep deletes their screenshots. Found through the DO's own order ids, before the orders lose their link.
        scrubReceiptsForOrders(this.sync, { orderIds: matchedIds(sqlx, 'orders', s) });
        return eraseCustomerRows(sqlx, s);
      });
      return { erased, remaining: countCustomerRows(sqlx, s) };
    }
    // MERCHANT erasure = ANONYMISATION in ONE transaction with the money gate (Rulings NZ-D16, NZ-D17, RETENTION-1): refused while
    // money is in flight; otherwise buyer data is anonymised, account / cart / consent / marketing data deleted, the merchant's own
    // contact and actor ids anonymised, fiscal / payment / VAT / ETA rows KEPT, and the store closed. No deleteAll.
    this.assertRegistryCoversSchema();
    return eraseMerchantAtomically(
      {
        sql: sqlx,
        sync: this.sync,
        transactionSync: fn => this.ctx.storage.transactionSync(fn),
        scrubReceipts: orderIds => scrubReceiptsForOrders(this.sync, { orderIds }),
        moneyInFlight: db => moneyInFlightOnDo(db) as unknown as Record<string, number>,
        closeStore: db => closeStore(db),
      },
      s.requestId
    );
  }

  /** PITR bookmark for "now" (SQLite-backed DOs, 30 days). Returned so the drill can record availability. */
  async pitrBookmark(): Promise<string> {
    const s = this.ctx.storage as unknown as { getCurrentBookmark(): Promise<string> };
    return s.getCurrentBookmark();
  }
}

/** A request named a store this instance does not serve. */
export class StoreMismatch extends Error {
  constructor() {
    super('this StoreDO serves a different store');
    this.name = 'StoreMismatch';
  }
}
