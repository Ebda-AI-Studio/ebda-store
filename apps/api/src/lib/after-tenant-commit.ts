/**
 * Post-response work that has to outlive the per-request tenant transaction.
 *
 * ## The defect class this exists to close
 *
 * `middleware/tenant-context.ts` runs each store-scoped request inside ONE
 * Prisma interactive transaction, held in AsyncLocalStorage.
 *
 * A fire-and-forget promise started inside a handler (`void Svc.doThing(...)`)
 * INHERITS that AsyncLocalStorage context. Any Prisma query it makes once that
 * transaction has settled lands on an already-committed transaction:
 *
 *   Transaction API error: Transaction already closed: A query cannot be
 *   executed on a committed transaction.  (P2028)
 *
 * Every such call site wraps itself in a logging `.catch`, so the work
 * silently never happened. Measured against a real Postgres (see
 * `tests/integration/after-tenant-commit.test.ts`): a detached promise with
 * even ONE `await` before its Prisma call loses the race reliably; a single
 * un-awaited query loses it whenever the handler returns promptly.
 *
 * ## The contract
 *
 * `deferAfterTenantCommit(name, run)` says: "run this AFTER the request's
 * tenant transaction has committed, in a FRESH tenant transaction carrying
 * the same `app.current_store_id` / `app.current_user_id` GUCs."
 *
 * - Inside a store-scoped request → the task is queued and executed after
 *   the commit, wrapped in its own `runInTenantContext(storeId, …, userId)`.
 *   Tenant scoping is therefore identical to the request's own — the GUCs are
 *   re-established, not dropped. (This is the same shape
 *   `payment-confirm.service.ts` already uses for its post-payment push:
 *   `void runInTenantContext(order.storeId, …)`.)
 * - Outside one (Inngest functions, crons, scripts, and the routers that are
 *   deliberately context-less) → there is no ambient transaction to outlive,
 *   so `run()` executes inline and its promise is returned unchanged. That is
 *   byte-identical to the behaviour before this module existed, which is why
 *   adopting it at a call site cannot regress a path that works today.
 * - If the request's transaction ROLLS BACK (handler returned 5xx) or its
 *   COMMIT fails, queued tasks are DROPPED: the rows they were about to react
 *   to no longer exist.
 *
 * Failures of deferred work are loud — error log plus the standard Telegram
 * alert — because a swallowed `.catch` is exactly why the original defect ran
 * undetected in production.
 *
 * ## Where the drain sits in the request lifecycle
 *
 * The request transaction now COMMITS BEFORE THE RESPONSE IS SENT
 * (`middleware/request-transaction.ts`), which makes the ordering of three
 * events — the commit, the response, the drain — a decision rather than an
 * accident. It is:
 *
 *     COMMIT  →  response released to the client  →  deferred work drains
 *
 * `withDeferredWork`'s optional `onCommitted` callback is how the middle step
 * is expressed: `request-transaction.ts` passes its own `releaseResponse`, and
 * this module calls it the moment the transaction resolves and BEFORE
 * awaiting the drain. So:
 *
 * - deferred work never runs inside the transaction (that is the P2028), and
 * - deferred work never blocks the response (an email send or an R2 delete on
 *   the client's latency path would be a regression the old
 *   commit-on-`finish` wiring did not have).
 *
 * On the streaming lane the response is already on the wire by the time the
 * transaction settles; `onCommitted` is then a no-op and the drain still runs
 * after the commit, so streaming exports keep their deferred work.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { onClosedTenantTxAccess, runInStoreScope, runInTenantContext } from '@ebda/database';
import logger from './logger';
import { cfBindings, cfWaitUntil } from '../cf/bindings';
import { sendAlert } from '../services/alerts.service';

interface DeferredTask {
  /** Stable, greppable identifier — appears in logs and alert headers. */
  name: string;
  run: () => Promise<unknown>;
  /**
   * Pooled connections the task holds at once (issue 2250). Every task holds
   * ONE for its own `runInTenantContext`; a task that opens a second
   * transaction while that one is open (`withRlsBypass`, `withMoneyTx`) holds
   * TWO and must say so, or DEFERRED_TX_GLOBAL_LIMIT under-counts.
   */
  connections: number;
  /** See DeferOptions.runOnRollback. */
  runOnRollback?: boolean;
}

export interface DeferOptions {
  /** See `DeferredTask.connections`. Default 1. */
  connections?: number;
  /**
   * Run this task even when the request transaction rolls back. ONLY for
   * work that records something that already happened OUTSIDE the database
   * and cannot be undone — e.g. the P1 for a provider refund that has
   * already left the gateway (PR 2279 audit). The default premise (the
   * rolled-back rows no longer exist, so drop the work) is false for those.
   */
  runOnRollback?: boolean;
}

interface DeferralScope {
  tasks: DeferredTask[];
  ctx: TenantCommitContext;
  /**
   * Set once this scope's `tasks` array has had its one and only chance to
   * be read — either `drain()` spliced it (`'drained'`) or the transaction
   * rolled back and it was cleared (`'rolledback'`). A call that arrives
   * after either — from a fire-and-forget promise created inside the
   * handler that outlived it, the exact anti-pattern this module exists to
   * close — would otherwise push into an array nothing will ever read again
   * and silently vanish.
   */
  closed?: 'drained' | 'rolledback';
}

export interface TenantCommitContext {
  storeId?: string;
  userId?: string;
  /**
   * The request is for a store on its Durable Object (NEON-ZERO-1, Ruling NZ-TX-1): its deferred tasks run under the lazy
   * per-query store scope with NO Postgres transaction and no pooled-connection slot.
   */
  noPgTx?: boolean;
}

const deferralStorage = new AsyncLocalStorage<DeferralScope>();

/**
 * True when the current async context is inside a request whose tenant
 * transaction commits after the response. Exported for call sites that need
 * to branch on it (e.g. to keep a synchronous return value honest).
 */
export function hasDeferralScope(): boolean {
  return deferralStorage.getStore() !== undefined;
}

/**
 * Queue `run` to execute after the ambient tenant transaction commits, or
 * execute it inline when there is no such transaction.
 *
 * Returns `run()`'s value when it ran inline, and `null` when it was deferred
 * (the result is not knowable yet). Callers that already treat this work as
 * fire-and-forget — every current one does — can ignore the difference.
 */
export function deferAfterTenantCommit<T>(
  name: string,
  run: () => Promise<T>,
  options: DeferOptions = {}
): Promise<T | null> {
  const connections = Math.max(1, Math.floor(options.connections ?? 1));
  const scope = deferralStorage.getStore();
  if (!scope) {
    const inline = run();
    // Track it like a drain, so `awaitDeferredWork` (graceful shutdown, a per-request database lease
    // closing) waits for a detached inline task instead of pulling its connection mid-transaction.
    const tracked: Promise<void> = inline.then(
      () => undefined,
      () => undefined
    );
    inFlightDrains.add(tracked);
    void tracked.finally(() => inFlightDrains.delete(tracked));
    // On a Worker the caller usually `void`s this: keep the work (and the request's database lease)
    // alive until it settles instead of letting it be cancelled with the response. Node: untouched.
    if (cfBindings()) cfWaitUntil(inline);
    return inline;
  }
  if (scope.closed) {
    // This call arrived from a promise that outlived the request it was
    // queued from (a fire-and-forget started inside the handler, still
    // resolving after `withDeferredWork` already returned) — report it
    // exactly like a stray Prisma call on a closed transaction
    // (`installClosedTenantTxAlerting`) rather than silently push into an
    // array nobody will ever read again.
    const ctx = scope.ctx;
    logger.error(
      { task: name, storeId: ctx.storeId, scopeState: scope.closed },
      `[after-tenant-commit] deferAfterTenantCommit called after its scope already ${scope.closed} — ` +
        'the caller outlived its request'
    );
    void sendAlert({
      level: 'p1',
      scope: 'platform',
      source: `after-tenant-commit.late.${name}`,
      title: `Deferred work queued after ${scope.closed}: ${name}`,
      body: `${name} was queued via deferAfterTenantCommit after its request's scope already ${scope.closed}.`,
      context: { task: name, storeId: ctx.storeId, scopeState: scope.closed },
    }).catch(() => undefined);
    if (scope.closed === 'rolledback' && !options.runOnRollback) {
      // The rows this work would react to no longer exist — dropping it is
      // the SAME decision the on-time rollback path already makes.
      return Promise.resolve(null);
    }
    // Committed and already drained: run it for real, in a fresh tenant
    // transaction — never inline, which would reach the ambient `prisma`
    // proxy on the now-committed request transaction and die with the same
    // P2028 this module exists to avoid.
    return runOneDeferredTask({ name, run, connections }, ctx).then(() => null);
  }
  scope.tasks.push({ name, run, connections, runOnRollback: options.runOnRollback });
  return Promise.resolve(null);
}

/**
 * Establish a deferral scope around a request's tenant transaction, then
 * drain whatever the handler queued once that transaction has committed.
 *
 * `fn` MUST be the `runInTenantContext(...)` call itself: the scope has to
 * live OUTSIDE the transaction so the drain happens after the commit, and
 * INSIDE this function's dynamic extent so handlers can find it.
 *
 * `onCommitted` — when given — fires between the COMMIT and the drain, and is
 * how the response is released to the client before any deferred work starts.
 * `middleware/request-transaction.ts` passes its `releaseResponse` here; see
 * the "Where the drain sits" section at the top of this file. It is NEVER
 * called when the transaction failed, which is exactly right: on that path the
 * middleware turns the discarded response into a 500 instead.
 */
export async function withDeferredWork<T>(
  ctx: TenantCommitContext,
  fn: () => Promise<T>,
  onCommitted?: () => void
): Promise<T> {
  const scope: DeferralScope = { tasks: [], ctx };
  let result: T;
  try {
    // `await` resumes in THIS function's context, which is outside the
    // AsyncLocalStorage store — so the drain below (and anything it calls)
    // sees no scope and runs its own work inline rather than re-queueing it.
    result = await deferralStorage.run(scope, fn);
  } catch (err) {
    // The tenant transaction rolled back (5xx handler, timeout, DB error) or
    // its COMMIT failed. Deferred work reacts to writes that no longer exist —
    // drop it. That premise only holds for work reacting to the REQUEST's
    // writes: anything recording a write that commits on its own (a
    // `prisma.$transaction([...])` batch is not proxied to this transaction)
    // must not be deferred at all — write it on the same transaction as the
    // write it records, as the affiliate money audit rows do
    // (`affiliateEventCreate`, #1590).
    // Tasks that opted into `runOnRollback` record something irreversible
    // that already happened outside the database: they still run (tracked
    // for graceful shutdown, never blocking the error response).
    const survivors = scope.tasks.filter(t => t.runOnRollback);
    const dropped = scope.tasks.filter(t => !t.runOnRollback);
    if (dropped.length > 0) {
      logger.warn(
        { storeId: ctx.storeId, dropped: dropped.map(t => t.name) },
        '[after-tenant-commit] tenant transaction failed — dropping deferred work'
      );
    }
    scope.tasks.length = 0;
    if (survivors.length > 0) void trackDrain(survivors, ctx);
    // Close the scope even though nothing is queued: a fire-and-forget
    // promise from the handler can still be resolving and call
    // deferAfterTenantCommit after we throw — see the `closed` field's doc.
    scope.closed = 'rolledback';
    throw err;
  }
  // COMMITTED. Let the client have its response BEFORE the drain: deferred
  // work is post-response work by definition and must not sit on the request's
  // latency path.
  onCommitted?.();
  // Close BEFORE draining: `drain()` splices `scope.tasks` exactly once, so
  // anything that arrives after this point has missed its only chance to be
  // read from that array — see the `closed` field's doc comment. The drain
  // itself goes through trackDrain so a graceful shutdown can wait on it (#1601).
  scope.closed = 'drained';
  await trackDrain(scope.tasks, ctx);
  return result;
}

/**
 * Every drain currently in flight, so a graceful shutdown can wait for them.
 * #1601: `gracefulShutdown` (index.ts) called `server.close()` then
 * `prisma.$disconnect()` with no idea whether any request's deferred work
 * (return-confirmation emails, R2 cleanup, audit rows) was still running — a
 * Railway redeploy could silently drop it mid-drain, with `$disconnect()`
 * pulling the connection out from under an in-progress task.
 */
const inFlightDrains = new Set<Promise<void>>();

/** Wraps `drain()` so its promise is tracked in `inFlightDrains` for its whole lifetime. */
async function trackDrain(tasks: DeferredTask[], ctx: TenantCommitContext): Promise<void> {
  if (tasks.length === 0) return;
  const p: Promise<void> = drain(tasks, ctx).finally(() => inFlightDrains.delete(p));
  inFlightDrains.add(p);
  await p;
}

/**
 * Wait for every currently in-flight deferred-work drain to finish, up to
 * `timeoutMs`. Call this from `gracefulShutdown`, after `server.close()`'s
 * callback fires (no new requests can start queuing drains) and BEFORE
 * `prisma.$disconnect()` — draining against a disconnected client would just
 * turn every in-flight task into a fresh, alerted failure.
 *
 * Never rejects: a timeout here means "stop waiting", not "something broke" —
 * `drain()` itself already swallows every task failure (see its doc comment),
 * so there is nothing here that would throw besides the race's own timer.
 */
export async function awaitDeferredWork(timeoutMs: number): Promise<void> {
  if (inFlightDrains.size === 0) return;
  const pending = Promise.all(Array.from(inFlightDrains)).then(() => undefined);
  await Promise.race([pending, new Promise<void>(resolve => setTimeout(resolve, timeoutMs))]);
}

/**
 * Run queued tasks sequentially, each in its own fresh tenant transaction.
 *
 * MUST NOT REJECT. By the time this runs the response is already on the wire,
 * so a rejection here cannot change the client's outcome — it would only
 * surface in `request-transaction.ts`'s failure branch and mislabel a
 * committed, delivered request as a transaction failure. Every task failure is
 * therefore reported and swallowed, including a failure of the reporter
 * itself.
 */
/**
 * How many deferred tasks run at once. A bulk operation that queues one task
 * per row (e.g. removing every banner image from a section) previously
 * drained them one Prisma interactive transaction at a time — for N queued
 * tasks, N sequential round trips on a request whose response has already
 * gone out, extending how long that connection is held open for no benefit
 * the client can see. Bounded rather than unbounded: opening all N at once
 * would spike connections against the Neon pooler on a large batch.
 */
const DRAIN_CONCURRENCY = 5;

/**
 * PROCESS-WIDE cap on pooled connections held by deferred work at once.
 *
 * DRAIN_CONCURRENCY bounds one request's drain, but each deferred task holds
 * a pooled connection for its whole `runInTenantContext` transaction, and
 * three concurrent requests draining a batch each reached 3 × 5 = 15 — the
 * entire default pool (`connection_limit`, DB_CONNECTION_LIMIT, default 15 —
 * packages/database/src/index.ts) — starving foreground requests into P2024 /
 * P2028. So every deferred task, on the drain AND on the late-arrival path,
 * also takes slots here. Derived from the pool size: a third of it, so
 * deferred work can never hold more than that share of the connections.
 *
 * The unit is CONNECTIONS, not tasks (issue 2250): `r2-cleanup.deleteOrphan`
 * nests a `withRlsBypass` transaction inside its tenant transaction, so it
 * holds two connections and takes two slots — counted per task, five such
 * tasks held 10 of 15 connections, two thirds rather than one.
 */
export const DEFERRED_TX_GLOBAL_LIMIT = Math.max(
  1,
  Math.floor((Number(process.env.DB_CONNECTION_LIMIT) || 15) / 3)
);

let deferredTxActive = 0;
const deferredTxWaiters: Array<{ n: number; resolve: () => void }> = [];

/** Test/observability hook: connections currently held by deferred work. */
export function deferredConnectionsInUse(): number {
  return deferredTxActive;
}

/**
 * Take `n` slots (clamped to the limit, so an oversized task can still run —
 * alone). Strict FIFO: a waiter is never overtaken by a later, smaller one,
 * so a two-slot task cannot be starved by a stream of one-slot tasks.
 */
async function acquireDeferredTxSlot(n: number): Promise<number> {
  const want = Math.min(n, DEFERRED_TX_GLOBAL_LIMIT);
  if (deferredTxWaiters.length === 0 && deferredTxActive + want <= DEFERRED_TX_GLOBAL_LIMIT) {
    deferredTxActive += want;
    return want;
  }
  await new Promise<void>(resolve => deferredTxWaiters.push({ n: want, resolve }));
  return want;
}

function releaseDeferredTxSlot(n: number): void {
  deferredTxActive -= n;
  // Admit waiters in order while the head fits; the grant is counted here, so
  // a woken waiter already owns its slots.
  while (deferredTxWaiters.length > 0) {
    const head = deferredTxWaiters[0];
    if (deferredTxActive + head.n > DEFERRED_TX_GLOBAL_LIMIT) break;
    deferredTxWaiters.shift();
    deferredTxActive += head.n;
    head.resolve();
  }
}

async function drain(tasks: DeferredTask[], ctx: TenantCommitContext): Promise<void> {
  if (tasks.length === 0) return;
  const queued = tasks.splice(0, tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < queued.length) {
      const task = queued[next++];
      await runOneDeferredTask(task, ctx);
    }
  };
  const workerCount = Math.min(DRAIN_CONCURRENCY, queued.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
}

/**
 * Run one deferred task in a fresh tenant transaction, holding
 * `task.connections` DEFERRED_TX_GLOBAL_LIMIT slots for its duration; never
 * rejects.
 */
async function runOneDeferredTask(task: DeferredTask, ctx: TenantCommitContext): Promise<void> {
  if (ctx.noPgTx && ctx.storeId) {
    try {
      await runInStoreScope(ctx.storeId, () => task.run().then(() => undefined));
    } catch (err) {
      try {
        reportDeferredFailure(task.name, err, ctx);
      } catch {
        // A broken logger/alerter must not strand the rest of the queue.
      }
    }
    return;
  }
  const held = await acquireDeferredTxSlot(task.connections);
  try {
    await runInTenantContext(ctx.storeId, () => task.run().then(() => undefined), ctx.userId);
  } catch (err) {
    try {
      reportDeferredFailure(task.name, err, ctx);
    } catch {
      // A broken logger/alerter must not strand the rest of the queue.
    }
  } finally {
    releaseDeferredTxSlot(held);
  }
}

function reportDeferredFailure(name: string, err: unknown, ctx: TenantCommitContext): void {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | null)?.code;
  logger.error(
    { err, task: name, code, storeId: ctx.storeId },
    '[after-tenant-commit] deferred post-response work failed'
  );
  void sendAlert({
    level: 'p1',
    scope: 'platform',
    source: `after-tenant-commit.${name}`,
    title: `Deferred post-response work failed: ${name}`,
    body: message.slice(0, 1000),
    context: { task: name, code, storeId: ctx.storeId },
  }).catch(() => undefined);
}

/**
 * Wire the `@ebda/database` closed-transaction detector to the API's logging
 * and alerting. Call once at boot.
 *
 * This is the enforcement half: `deferAfterTenantCommit` fixes the sites we
 * know about, this names any site we missed (or that gets added later) the
 * first time it fires, instead of leaving it in a swallowed `.catch`. It does
 * not change query routing — the P2028 still throws exactly as before.
 *
 * #1598: a stray access on a tx that ROLLED BACK (`reason: 'aborted'`) is
 * downgraded to `logger.debug` with no alert. That request already errored
 * and every write it made — committed or not — is undone; a P2028 reaching
 * here on that path is routine noise on the error path, not the silent loss
 * of committed work this alert exists to catch. A client disconnect lands
 * here too since issue 1604: `request-transaction.ts` now ROLLS BACK a request
 * whose client went away mid-handler, so the handler's remaining queries are
 * accesses on an 'aborted' tx — expected, and debug-level.
 */
export function installClosedTenantTxAlerting(): void {
  onClosedTenantTxAccess(({ property, stack, reason }) => {
    if (reason === 'aborted') {
      logger.debug(
        { property, stack },
        '[after-tenant-commit] Prisma call on a ROLLED-BACK tenant transaction — ' +
          'routine on the error path, no alert'
      );
      return;
    }
    logger.error(
      { property, stack },
      '[after-tenant-commit] Prisma call on a COMMITTED tenant transaction — ' +
        'this work is being silently dropped; wrap it in deferAfterTenantCommit()'
    );
    void sendAlert({
      level: 'p1',
      scope: 'platform',
      source: 'after-tenant-commit.closed_tx_access',
      title: 'Prisma call on a committed tenant transaction',
      body:
        `prisma.${property} was reached after the request's tenant transaction committed. ` +
        'The query will fail with P2028 and its work will be lost.',
      context: { property, stack: stack?.slice(0, 1200) },
    }).catch(() => undefined);
  });
}
