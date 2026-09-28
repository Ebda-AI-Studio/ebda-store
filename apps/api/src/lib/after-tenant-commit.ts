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
import { onClosedTenantTxAccess, runInTenantContext } from '@force/database';
import logger from './logger';
import { sendAlert } from '../services/alerts.service';

interface DeferredTask {
  /** Stable, greppable identifier — appears in logs and alert headers. */
  name: string;
  run: () => Promise<unknown>;
}

interface DeferralScope {
  tasks: DeferredTask[];
}

export interface TenantCommitContext {
  storeId?: string;
  userId?: string;
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
export function deferAfterTenantCommit<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  const scope = deferralStorage.getStore();
  if (!scope) {
    return run();
  }
  scope.tasks.push({ name, run });
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
  const scope: DeferralScope = { tasks: [] };
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
    if (scope.tasks.length > 0) {
      logger.warn(
        { storeId: ctx.storeId, dropped: scope.tasks.map(t => t.name) },
        '[after-tenant-commit] tenant transaction failed — dropping deferred work'
      );
      scope.tasks.length = 0;
    }
    throw err;
  }
  // COMMITTED. Let the client have its response BEFORE the drain: deferred
  // work is post-response work by definition and must not sit on the request's
  // latency path.
  onCommitted?.();
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
async function drain(tasks: DeferredTask[], ctx: TenantCommitContext): Promise<void> {
  if (tasks.length === 0) return;
  const queued = tasks.splice(0, tasks.length);
  for (const task of queued) {
    try {
      await runInTenantContext(ctx.storeId, () => task.run().then(() => undefined), ctx.userId);
    } catch (err) {
      try {
        reportDeferredFailure(task.name, err, ctx);
      } catch {
        // A broken logger/alerter must not strand the rest of the queue.
      }
    }
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
 * Wire the `@force/database` closed-transaction detector to the API's logging
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
 * of committed work this alert exists to catch (a client disconnect does NOT
 * land here: `request-transaction.ts` deliberately lets that tx commit, so it
 * reports 'committed' like any other successful request).
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
