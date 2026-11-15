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
import { publishIndexHealth } from './index-health';
import { handleStoreAdmin } from '../../../../../packages/cf-migrate/src/store-admin.mjs';
import {
  createPrismaLite,
  doSqlRunner,
  doSyncSql,
  answerStockOp,
  answerMoneyOp,
  drainEntityIndexOutbox,
  awaitEntityIndexed,
  outboxHighWater,
  paymentIndexIds,
  outboxRowsAfter,
  nextOutboxAttempt,
  deadLetterReport,
  ensureMoneyOpsSchema,
  type MoneyAnswer,
  applyStoreSettings,
  patchStoreSettings,
  patchStoreSettingsIf,
  bootstrapStoreRows,
  readStoreRecord,
  encodeRpc,
  decodeRpc,
  ensureStockOpsSchema,
  type StockAnswer,
  answerAuthOp,
  ensureCustomerAuthSchema,
  purgeCustomerAuth,
  type AuthAnswer,
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
  scrubUserFromStoreDo,
  MoneyError,
  runReads,
  runWrites,
  revivePrismaNulls,
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
  buildCustomerAuthBackup,
  dumpCustomerAuth,
  loadCustomerAuth,
  readCustomerAuthBackup,
  CUSTOMER_AUTH_FILE,
  dumpTables,
  loadBackup,
  beginLoad,
  endLoad,
  goldFlagOf,
  restoreWrittenTables,
  loadTableBody,
  exportChunked,
  totalRows,
  tableDigest,
  tableFiles,
  BACKUP_SNAPSHOT_ROWS,
  BACKUP_PART_ROWS,
  sha256Hex,
  backupKey,
  verifyWritten,
  type BackupManifest,
  type BackupOpts,
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
/** Ruling NZ-MONEY-2: how long a money op waits for its own D1 index rows before answering 503 (review M-1). */
const INDEX_DRAIN_TIMEOUT_MS = 3000;
/** Ruling NZ-MONEY-2: the earliest index-retry alarm after a failed write (env STORE_DO_INDEX_RETRY_MS overrides it). */
const INDEX_RETRY_FLOOR_MS = 30_000;
/** An alarm this close to the backup due date runs the backup (an alarm fires a little early or late). */
const BACKUP_DUE_SLACK_MS = 60_000;

/** Ops whose answer hands a payment reference out (see `moneyOp`): each answers `{ paymentId }`. */
const PAYMENT_REFERENCE_OPS: ReadonlySet<string> = new Set([
  'paymentCreate',
  'instapayInitiate',
  'paymentIndexCheck',
]);
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
      ensureCustomerAuthSchema(this.sync);
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
      return await runReads(await this.lite(storeId), revivePrismaNulls(queries));
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
      // Prisma null sentinels arrive tagged (they cannot be structured-cloned, Ruling PRISMA-NULL-RPC-1)
      return await runWrites(
        await this.lite(storeId),
        doSqlRunner(this.ctx.storage),
        revivePrismaNulls(m)
      );
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
  async moneyOp(storeId: string, op: string, argsJson: string, key?: string): Promise<MoneyAnswer> {
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
    const before = outboxHighWater(this.sync);
    const answer = answerMoneyOp(this.sync, storeId, op, argsJson, key);
    // The section above queued the id -> store rows of what it created (orders, payments, gateway references) in `d1_outbox`.
    // They are written to D1 `entity_index` BEFORE the answer, so the shopper's next call (POST /payments/create by order id)
    // and the gateway's webhook (by reference) resolve this store (Ruling NZ-MONEY-2).
    const own = outboxRowsAfter(this.sync, before);
    let indexed = true;
    // (a payment op's own rows ARE its payment's rows: `paymentRoutable` below writes and checks them)
    if (own.length > 0 && !PAYMENT_REFERENCE_OPS.has(op))
      indexed = await this.indexOwnRows(storeId, own, before);
    // The backlog of earlier failures, bounded so it never weighs on this op (review M-2), then the retry alarm for whatever is
    // still queued (this op's rows included).
    if (indexed) await this.drainIndex(10);
    // A PAYMENT reference is handed out only when D1 can route it (review I-2 / NEW-1): the first create, every replay that
    // returns the same row (COD reuse, InstaPay hold reuse) and every route that hands an existing payment out again
    // (`paymentIndexCheck`) must find the payment's rows IN D1, written now if they are still queued; else 503
    // ENTITY_INDEX_UNAVAILABLE (replay-safe: the row is committed and every retry returns it). The check reads D1, not
    // "did this call write rows", so a retry inside the backoff window is refused too. Any other op (a checkout order, a refund
    // claim) keeps its answer: its retry would not re-run its post-commit work (review NEW-2); its rows wait for the alarm.
    if (answer.ok && PAYMENT_REFERENCE_OPS.has(op)) {
      const paymentId = (decodeRpc(answer.json) as { paymentId?: unknown }).paymentId;
      if (typeof paymentId === 'string' && !(await this.paymentRoutable(storeId, paymentId))) {
        await this.armIndexRetry();
        return {
          ok: false,
          code: 'ENTITY_INDEX_UNAVAILABLE',
          status: 503,
          message: 'the store directory could not be updated; try again',
        };
      }
    }
    await this.armIndexRetry();
    return answer;
  }

  /**
   * The payment's index rows (payment id + gateway references) are in D1 and name THIS store: its still-queued rows are written
   * NOW (backoff ignored), then every id is read back (`awaitEntityIndexed`, fail closed). Bounded to 3 s. Never throws.
   */
  private async paymentRoutable(storeId: string, paymentId: string): Promise<boolean> {
    const d1 = this.env.PLATFORM_DB;
    if (!d1) return true; // no D1 bound (Node / local dev): nothing to route through
    const ids = paymentIndexIds(this.sync, storeId, paymentId);
    if (ids.length === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await drainEntityIndexOutbox(this.sync, d1, { onlyIds: ids.map(i => i.id) });
          // limit 0: only the read-back (the forced drain above did the writing, without counting attempts)
          await awaitEntityIndexed(this.sync, d1, storeId, ids, { limit: 0 });
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('entity index check timed out')),
            INDEX_DRAIN_TIMEOUT_MS
          );
        }),
      ]);
      return true;
    } catch (err) {
      console.error(
        `[P1] payment ${paymentId} not routable in D1: ${(err as Error)?.message ?? err}`
      );
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Write THIS op's index rows and read them back from D1 (`awaitEntityIndexed`: fail closed on a missing row or another store's
   * row). Bounded in time (review M-1): a slow D1 is a "not indexed", never a hung money op. Never throws.
   */
  private async indexOwnRows(
    storeId: string,
    own: Array<{ kind: string; id: string }>,
    afterId: number
  ): Promise<boolean> {
    const d1 = this.env.PLATFORM_DB;
    if (!d1) return true; // no D1 bound (Node / local dev): nothing to route through
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        awaitEntityIndexed(this.sync, d1, storeId, own, { afterId, limit: own.length }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('entity index write timed out')),
            INDEX_DRAIN_TIMEOUT_MS
          );
        }),
      ]);
      return true;
    } catch (err) {
      // a conflict (the id is another store's) is a P1 for a human: the Worker's log drain alerts on this line
      console.error(
        `[P1] entity index not written for ${JSON.stringify(own)}: ${(err as Error)?.message ?? err}`
      );
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Record the dead-lettered / abandoned rows where the API Worker's hourly health cron reads them (cf/store-do/index-health.ts):
   * this DO cannot call sendAlert. A D1 call only when the set changed.
   */
  private async publishIndexHealth(d1: unknown): Promise<void> {
    try {
      const report = deadLetterReport(this.sync);
      const storeId = report.rows[0]?.storeId || this.boundStoreId();
      if (!storeId) return;
      const lastRaw = this.sync.all("SELECT v FROM _identity WHERE k = 'index_health_sig'", [])[0]
        ?.v as string | undefined;
      const sig = await publishIndexHealth(
        d1 as Parameters<typeof publishIndexHealth>[0],
        storeId,
        report,
        lastRaw || null
      );
      if ((sig ?? null) !== (lastRaw || null))
        this.sync.run(
          "INSERT INTO _identity (k, v) VALUES ('index_health_sig', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
          [sig ?? '']
        );
    } catch (err) {
      console.error('entity index health failed', err);
    }
  }

  /** Write up to `limit` due `d1_outbox` entity-index rows to D1 (idempotent; nothing due = no D1 call). Never throws. */
  private async drainIndex(limit = 100, includeDead = false): Promise<void> {
    const d1 = this.env.PLATFORM_DB;
    if (!d1) return;
    try {
      const r = await drainEntityIndexOutbox(this.sync, d1, { limit, includeDead });
      // once per row, when it crosses the dead-letter limit (~hours of failed paced attempts): a human must look
      if (r.newlyDead > 0)
        console.error(
          `[P1] entity index rows dead-lettered: ${r.newlyDead} (still retried hourly by the alarm)`
        );
      if (r.failed > 0 || r.conflicts.length > 0)
        console.error('entity index drain incomplete', JSON.stringify(r));
      if (r.newlyAbandoned > 0)
        console.error(
          `[P1] entity index rows abandoned: ${r.newlyAbandoned} (past the retry cap, no more background wakes; the health cron alerts)`
        );
      await this.publishIndexHealth(d1);
    } catch (err) {
      console.error('[P1] entity index drain failed', err);
    }
  }

  /**
   * Rows still queued: arm the alarm for their next attempt (never earlier than the retry floor, default 30 s; the outbox backoff
   * spaces later attempts), unless an earlier alarm is already set. The backup is not disturbed: `alarm()` backs up only when
   * the backup is due.
   */
  private async armIndexRetry(): Promise<void> {
    const next = nextOutboxAttempt(this.sync);
    if (next === null) return;
    const floor = Number(this.env.STORE_DO_INDEX_RETRY_MS ?? INDEX_RETRY_FLOOR_MS);
    const at = Math.max(next, Date.now() + (Number.isFinite(floor) ? floor : INDEX_RETRY_FLOOR_MS));
    await this.ensureBackupDue();
    const cur = await this.ctx.storage.getAlarm();
    if (!cur || cur > at) await this.ctx.storage.setAlarm(at);
  }

  /** When the next nightly backup is due (epoch ms) or null when never recorded (a DO armed before the due date existed). */
  private backupDueAt(): number | null {
    const row = this.ctx.storage.sql
      .exec("SELECT v FROM _identity WHERE k = 'backup_due_at'")
      .toArray()[0] as { v: string } | undefined;
    return row ? Number(row.v) : null;
  }
  private setBackupDueAt(at: number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO _identity (k, v) VALUES ('backup_due_at', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
      String(at)
    );
  }
  /** Record the due date of the backup the CURRENT alarm stands for, before an earlier retry alarm replaces it. */
  private async ensureBackupDue(): Promise<void> {
    if (this.backupDueAt() !== null) return;
    const cur = await this.ctx.storage.getAlarm();
    this.setBackupDueAt(cur ?? Date.now() + DAY_MS);
  }

  /**
   * Storefront CUSTOMER authentication (NEON-ZERO-1 N-9, Ruling NZ-A3): one named operation = one synchronous section over the
   * `_cauth_*` tables (packages/repo/src/do/customer-auth.ts). The password compare runs in the API Worker (bcrypt cost 12 would starve the single-threaded DO); the DO hands the hash only to that
   * Worker over this stub. A refusal is an ANSWER. A closed store refuses everything but reads of state.
   */
  async authOp(storeId: string, op: string, argsJson: string): Promise<AuthAnswer> {
    try {
      this.bind(storeId);
    } catch (e) {
      if (e instanceof StoreMismatch)
        return { ok: false, code: 'STORE_MISMATCH', status: 403, message: e.message };
      return { ok: false, code: 'STORE_NOT_FOUND', status: 404, message: 'store not found' };
    }
    if (
      isStoreClosed(this.sync) &&
      !/^(userState|getProfile|exportCustomer|exportRowsPage|counts|isLive)$/.test(op)
    )
      return { ok: false, code: 'STORE_CLOSED', status: 410, message: 'store is closed' };
    return answerAuthOp(this.sync, op, argsJson);
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
   * The atomic settings PATCH (BE:F-2 / BE:F-3): merges ONLY the sent top-level keys of `settings` / `theme` / `socialLinks` against
   * the value this DO holds now and writes any plain `fields` in the same synchronous transaction, so interleaved saves of
   * different keys both survive and a refusal rolls the whole patch back. Input is an RPC JSON string `{ fields?, json? }`.
   */
  async patchSettings(
    storeId: string,
    inputJson: string
  ): Promise<Result<{ profile: string[]; config: string[]; directoryOnly: string[] }>> {
    try {
      this.bind(storeId);
      if (isStoreClosed(this.sync)) return { ok: false, code: 'STORE_CLOSED', status: 410 };
      const meta = (await import('@ebda-src/prisma-meta')).default as unknown as Meta;
      const input = decodeRpc<{
        fields?: Record<string, unknown>;
        json?: Record<string, { set?: Record<string, unknown>; remove?: string[] }>;
      }>(inputJson);
      return {
        ok: true,
        data: patchStoreSettings(doSqlRunner(this.ctx.storage), meta, storeId, input),
      };
    } catch (e) {
      if (e instanceof StoreMismatch) return { ok: false, code: 'STORE_MISMATCH', status: 403 };
      const err = e as { code?: string };
      return { ok: false, code: err.code ?? 'SETTINGS_REFUSED', status: 409 };
    }
  }

  /**
   * The CONDITIONAL settings patch (STORE-LIFECYCLE-1 h): check `settings[expect.key]` is still `{id, state}` and write, in the same
   * synchronous transaction. `applied: false` = the condition no longer held, nothing was written.
   */
  async patchSettingsIf(
    storeId: string,
    inputJson: string,
    expectJson: string
  ): Promise<Result<{ applied: boolean }>> {
    try {
      this.bind(storeId);
      if (isStoreClosed(this.sync)) return { ok: false, code: 'STORE_CLOSED', status: 410 };
      const meta = (await import('@ebda-src/prisma-meta')).default as unknown as Meta;
      const input = decodeRpc<{
        fields?: Record<string, unknown>;
        json?: Record<string, { set?: Record<string, unknown>; remove?: string[] }>;
      }>(inputJson);
      const expect = decodeRpc<{ key: string; id: string; state: string }>(expectJson);
      return {
        ok: true,
        data: patchStoreSettingsIf(doSqlRunner(this.ctx.storage), meta, storeId, {
          ...input,
          expect,
        }),
      };
    } catch (e) {
      if (e instanceof StoreMismatch) return { ok: false, code: 'STORE_MISMATCH', status: 403 };
      const err = e as { code?: string };
      return { ok: false, code: err.code ?? 'SETTINGS_REFUSED', status: 409 };
    }
  }

  /**
   * First-time bootstrap of a store created on this DO (N-18, Ruling NZ-D11): `store_profile` + `store_config` + the inactive
   * default VAT rate. Idempotent (a retry converges). The API wrote the D1 directory row first.
   */
  async bootstrapStore(
    storeId: string,
    inputJson: string
  ): Promise<Result<{ profile: string[]; config: string[]; directoryOnly: string[] }>> {
    try {
      this.bind(storeId);
      if (isStoreClosed(this.sync)) return { ok: false, code: 'STORE_CLOSED', status: 410 };
      const meta = (await import('@ebda-src/prisma-meta')).default as unknown as Meta;
      const input = decodeRpc<{
        identity: { name: string; slug: string; ownerId: string };
        fields: Record<string, unknown>;
        vat?: { id: string; name: string; nameAr: string; rate: number };
        cod?: { id: string; name: string; nameAr: string; currency: string };
      }>(inputJson);
      return {
        ok: true,
        data: bootstrapStoreRows(doSqlRunner(this.ctx.storage), meta, storeId, input),
      };
    } catch (e) {
      if (e instanceof StoreMismatch) return { ok: false, code: 'STORE_MISMATCH', status: 403 };
      const err = e as { code?: string };
      return { ok: false, code: err.code ?? 'BOOTSTRAP_REFUSED', status: 409 };
    }
  }

  /**
   * The Store record for the API Worker (NEON-ZERO-1): profile + config as Prisma `Store` fields, wire-encoded. ONE
   * call per request (NEON-SCALE-1 rule 9); a refusal is an ANSWER. `missing` lists D1-only fields the caller reads from D1.
   */
  async storeRecord(
    storeId: string,
    fields?: string[]
  ): Promise<
    | Result<{ json: string; missing: string[] }>
    | { ok: false; code: string; status: number; message: string }
  > {
    try {
      this.bind(storeId);
      const meta = (await import('@ebda-src/prisma-meta')).default as unknown as Meta;
      const out = readStoreRecord(doSqlRunner(this.ctx.storage), meta, storeId, fields);
      if (!out) return { ok: false, code: 'STORE_NOT_FOUND', status: 404 };
      return { ok: true, data: { json: encodeRpc(out.record), missing: out.missing } };
    } catch (e) {
      if (e instanceof StoreMismatch) return { ok: false, code: 'STORE_MISMATCH', status: 403 };
      // A refusal must be diagnosable: the underlying message (an unknown field, a relation) rides the answer and the log.
      const message = String((e as Error)?.message ?? e).slice(0, 300);
      console.error(`[store-do] storeRecord refused: ${message}`);
      return { ok: false, code: 'STORE_RECORD_REFUSED', status: 400, message };
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
    if (cur) {
      await this.ensureBackupDue();
      return cur;
    }
    const at = Date.now() + DAY_MS;
    this.setBackupDueAt(at);
    await this.ctx.storage.setAlarm(at);
    return at;
  }

  private bucket(): R2Like | undefined {
    return this.env.STORE_BACKUPS as R2Like | undefined;
  }

  /** Export every table + manifest to R2 under store-do-backups/<store>/<yyyy-mm-dd>/. */
  async backupNow(storeId: string, opts: BackupOpts = {}): Promise<BackupManifest> {
    this.bind(storeId);
    const r2 = this.bucket();
    if (!r2) throw new Error('STORE_BACKUPS binding missing');
    // Large store (P2-4): paged by primary key, parts written one by one, never the whole database in memory.
    if (totalRows(this.ctx.storage.sql) > (opts.snapshotRows ?? BACKUP_SNAPSHOT_ROWS))
      return this.backupChunked(storeId, r2, opts.partRows ?? BACKUP_PART_ROWS);
    const dump = dumpTables(this.ctx.storage.sql); // sync read: consistent snapshot
    const authDump = dumpCustomerAuth(this.ctx.storage.sql); // same turn: the same snapshot
    const { manifest, files } = await buildBackup(storeId, dump);
    // Customer credentials (N-9, Ruling NZ-N9-3): ENCRYPTED, or the backup FAILS (loudly, before a manifest is written).
    // A plaintext fallback does not exist: a store with customer accounts and no key is a failed night, not a silent skip.
    const ca = await buildCustomerAuthBackup(
      authDump,
      this.env.CUSTOMER_AUTH_BACKUP_KEY as string | undefined
    );
    if (ca) manifest.customerAuth = ca.entry;
    const day = manifest.takenAt.slice(0, 10);
    for (const [name, body] of Object.entries(files))
      await r2.put(backupKey(storeId, day, name), body);
    if (ca) await r2.put(backupKey(storeId, day, CUSTOMER_AUTH_FILE), ca.blob);
    // The manifest goes last: a day folder without one is an incomplete backup and must be ignored.
    await r2.put(backupKey(storeId, day, 'manifest.json'), JSON.stringify(manifest, null, 2));
    // Read-back (rule N11): a backup that is not read back is not a backup.
    await verifyWritten(r2, storeId, day, manifest);
    return manifest;
  }

  /**
   * Paged export. The pages are read synchronously but R2 is awaited between them, so the store is held in `blockConcurrencyWhile`:
   * no write can land between two pages and the parts together are still ONE consistent snapshot (a torn read could leave an
   * order item whose order is in an earlier part's past). The platform resets a DO whose block runs over 30 s: a store too big
   * for that fails the night loudly (sweep P1) instead of writing a torn backup; the Mac pull of `__export` is the safety net.
   */
  private async backupChunked(
    storeId: string,
    r2: R2Like,
    partRows: number
  ): Promise<BackupManifest> {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const { tables, authDump } = await this.ctx.blockConcurrencyWhile(async () => ({
      authDump: dumpCustomerAuth(this.ctx.storage.sql),
      tables: await exportChunked(
        this.ctx.storage.sql,
        (file, body) => r2.put(backupKey(storeId, day, file), body),
        partRows
      ),
    }));
    const manifest: BackupManifest = {
      version: 1,
      storeId,
      takenAt: now.toISOString(),
      tables,
      partRows,
    };
    const ca = await buildCustomerAuthBackup(
      authDump,
      this.env.CUSTOMER_AUTH_BACKUP_KEY as string | undefined
    );
    if (ca) manifest.customerAuth = ca.entry;
    if (ca) await r2.put(backupKey(storeId, day, CUSTOMER_AUTH_FILE), ca.blob);
    await r2.put(backupKey(storeId, day, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await verifyWritten(r2, storeId, day, manifest);
    return manifest;
  }

  async alarm(): Promise<void> {
    // The index retry (Ruling NZ-MONEY-2): the rows a money op could not write wait in the outbox with backoff; dead-lettered
    // rows are retried too, on their capped hourly backoff (a money row is never abandoned, review NEW-3).
    await this.drainIndex(100, true);
    const now = Date.now();
    const due = this.backupDueAt();
    // The nightly work runs only when it is due: an earlier alarm armed for an index retry must not back the store up.
    // `null` = a DO armed before the due date was recorded: its alarm IS the nightly one.
    const backupDue = due === null || due <= now + BACKUP_DUE_SLACK_MS;
    try {
      // Retention purges on every alarm (cheap, idempotent).
      // The saved scope of a half-finished shopper erasure never outlives its TTL (Ruling CF-R6A-3).
      try {
        purgeErasureLedger(this.sync);
      } catch (err) {
        console.error('erasure ledger purge failed', err);
      }
      // Customer-auth retention (N-9): expired / used tokens and long-revoked refresh rows.
      try {
        purgeCustomerAuth(this.sync);
      } catch (err) {
        console.error('customer auth purge failed', err);
      }
      if (backupDue) {
        const storeId = this.boundStoreId();
        if (storeId) await this.backupNow(storeId);
      }
    } finally {
      // Re-arm even when the export threw: a failed night must not stop the next one (alerting: a missing
      // manifest for yesterday is the signal, see docs/plans/2026-10-29-cf-phase0-go-no-go.md).
      if (backupDue) this.setBackupDueAt(now + DAY_MS);
      await this.ctx.storage.setAlarm(this.backupDueAt() ?? now + DAY_MS);
      // and the index retry, when rows are still queued (it only ever moves the alarm EARLIER)
      await this.armIndexRetry();
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
    const paged = tables.some(t => manifest.tables[t].parts);
    // Legacy / small backups: every file is read and checked first, then one transaction (all or nothing), as before.
    const files: Record<string, string> = {};
    if (!paged)
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
    let authDump: Awaited<ReturnType<typeof readCustomerAuthBackup>> | undefined;
    if (manifest.customerAuth) {
      const cf = await r2.get(backupKey(sourceStoreId, day, manifest.customerAuth.file));
      if (!cf) throw new Error(`missing ${manifest.customerAuth.file}`);
      authDump = await readCustomerAuthBackup(
        await cf.text(),
        manifest.customerAuth,
        this.env.CUSTOMER_AUTH_BACKUP_KEY as string | undefined
      );
    }
    if (!paged)
      this.ctx.storage.transactionSync(() => {
        loadBackup(this.ctx.storage.sql, files, tables);
        if (authDump) loadCustomerAuth(this.ctx.storage.sql, authDump);
      });
    else await this.restorePaged(r2, sourceStoreId, day, manifest, tables, [...live], authDump);
    // Re-export the restored DO with the same canonical serialization and compare to the manifest.
    const got: Record<string, { rows: number; sha256: string }> = paged
      ? await exportChunked(this.ctx.storage.sql, async () => {}, this.restorePartRows(manifest))
      : (await buildBackup(sourceStoreId, dumpTables(this.ctx.storage.sql))).manifest.tables;
    const out: Record<string, { rows: number; sha256: string; ok: boolean }> = {};
    for (const t of tables) {
      const want = manifest.tables[t];
      out[t] = {
        rows: got[t].rows,
        sha256: got[t].sha256,
        ok: got[t].rows === want.rows && got[t].sha256 === want.sha256,
      };
    }
    return out;
  }

  /** The re-export must page exactly like the backup did (the manifest records the page size). */
  private restorePartRows(manifest: BackupManifest): number {
    return manifest.partRows ?? BACKUP_PART_ROWS;
  }

  /**
   * Restore a paged backup part by part (P2-4): one R2 read and one transaction per part, so memory is one part. Atomicity is
   * compensating, not transactional: the target was verified EMPTY, so a failure at any point deletes every row again. Foreign keys
   * are switched off for the load (parts arrive in table order, a child can precede its parent) and verified with
   * `foreign_key_check` before the flag is cleared; `PRAGMA foreign_keys` is a no-op inside a transaction, hence outside each one.
   */
  private async restorePaged(
    r2: R2Like,
    sourceStoreId: string,
    day: string,
    manifest: BackupManifest,
    tables: string[],
    live: string[],
    authDump: Awaited<ReturnType<typeof readCustomerAuthBackup>> | undefined
  ): Promise<void> {
    const sql = this.ctx.storage.sql;
    sql.exec('PRAGMA foreign_keys = OFF');
    const gold = beginLoad(sql, tables);
    let backupFlag: unknown;
    try {
      for (const t of tables) {
        const tm = manifest.tables[t];
        for (const file of tableFiles(t, tm)) {
          const f = await r2.get(backupKey(sourceStoreId, day, file));
          if (!f) throw new Error(`missing ${file}`);
          const body = await f.text();
          const want = tm.parts ? tm.parts.find(p => p.file === file)!.sha256 : tm.sha256;
          if ((await sha256Hex(body)) !== want)
            throw new Error(`${t}: file checksum differs from manifest`);
          this.ctx.storage.transactionSync(() => loadTableBody(sql, t, body));
          if (t === 'do_flags') backupFlag = goldFlagOf(body) ?? backupFlag;
        }
        if (tm.parts && (await tableDigest(tm.parts)) !== tm.sha256)
          throw new Error(`${t}: part digest differs from manifest`);
      }
      this.ctx.storage.transactionSync(() => {
        if (authDump) loadCustomerAuth(sql, authDump);
      });
      const bad = sql.exec('PRAGMA foreign_key_check').toArray();
      if (bad.length)
        throw new Error(
          `restore left ${bad.length} dangling foreign key(s), first in ${String(bad[0].table)}`
        );
      endLoad(sql, gold, backupFlag);
    } catch (e) {
      // Compensating rollback: the target was empty, so empty it again (a half-restored store must never serve).
      // (every table the restore wrote: the live tables AND the `_cauth_*` credential tables, which `storeTables` does not list)
      for (const t of new Set([...live, ...restoreWrittenTables(tables, !!authDump)]))
        sql.exec(`DELETE FROM "${t}"`);
      throw e;
    } finally {
      // The pragma is a no-op while this turn still has uncommitted writes (measured on workerd): flush, set, then READ IT BACK.
      await this.ctx.storage.sync();
      sql.exec('PRAGMA foreign_keys = ON');
      if (Number(sql.exec('PRAGMA foreign_keys').toArray()[0].foreign_keys) !== 1)
        throw new Error('restore: foreign keys could not be re-enabled');
    }
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

  /**
   * User erasure of ACTOR ids (OFFBOARD-1, Ruling FOLD-ERASURE-1): every column the classification lists under `actorScrub` for the
   * StoreDO that holds this user's id (created_by, approved_by, ...) is replaced by NULL or its tombstone. Rows stay. Idempotent.
   */
  scrubActor(userId: string): { rows: number } {
    return scrubUserFromStoreDo(this.sync, userId);
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
