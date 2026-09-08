import { Response, NextFunction } from 'express';
import logger from '../lib/logger';

/**
 * Request-transaction lifecycle: COMMIT BEFORE RESPOND.
 *
 * `tenantContext` / `userContext` (./tenant-context.ts) run each request
 * inside ONE Prisma interactive transaction. This module owns the question of
 * *when that transaction settles relative to the bytes going out*.
 *
 * ## The defect this replaces
 *
 * The original wiring resolved the transaction from `res.on('finish')` — i.e.
 * the HTTP response was flushed to the client and only THEN did Postgres
 * COMMIT. Two live consequences:
 *
 *   1. **A 2xx did not mean durable.** A COMMIT that failed after a 201 had
 *      already been sent was a silent lost write on a revenue path: the
 *      customer was told it worked and it did not. Nothing could report it —
 *      the status line was already on the wire.
 *   2. **The client's next request raced the previous one's writes.** A
 *      strictly sequential caller could read back its own write and not see
 *      it. That is the root cause behind the cart 500s fixed in #1580, and
 *      the reason `awaitCartCommitted()` had to exist in the test helpers.
 *
 * ## The two lanes
 *
 * There is no single point at which "the handler is done" is knowable for
 * every response shape, so this module splits requests into two explicitly
 * enforced lanes and never guesses which one a request is in:
 *
 * ### BUFFERED lane (the default — every JSON / redirect / buffered download)
 *
 * `res.json` → `res.send` → `res.end` is the single choke point for every
 * fully-materialised response Express produces. We intercept `res.end`,
 * **capture** its arguments instead of writing them, settle the transaction
 * (commit on <500, roll back on >=500), and only replay the captured
 * `res.end` once Postgres has answered. So:
 *
 *   - a 2xx reaching the client is a COMMITTED 2xx, always;
 *   - a COMMIT that fails becomes a 500 the client actually sees, instead of
 *     a 201 over a lost write;
 *   - by the time the client can issue its next request, its writes are
 *     visible to every other connection.
 *
 * ### STREAMING lane (escalated, never chosen by us)
 *
 * A handler that calls `res.write()`, `res.download()`, `res.sendFile()`,
 * `res.flushHeaders()`, or pipes a readable into `res` (which calls
 * `res.write` internally) has already committed to putting bytes on the wire
 * incrementally, and typically keeps querying the database BETWEEN chunks.
 * For that shape "commit first" is not merely awkward, it is WRONG twice
 * over: committing before the stream starts would drop every mid-stream query
 * out of the tenant transaction (losing the RLS GUC), and committing after
 * capture is impossible because there is nothing to capture.
 *
 * So a streaming response ESCALATES: the first streaming primitive flips the
 * lane, and the transaction settles on `res.on('finish')` / `res.on('close')`
 * exactly as it always did. Streaming responses therefore KEEP the old
 * commit-after-flush semantics, and keep the old residual with them (a COMMIT
 * that fails after a 200 has started streaming cannot be reported to the
 * client — the status line is already gone). That residual is accepted, not
 * fixed, and it is bounded to the streaming lane on purpose: shipping a
 * commit-first path for streams would truncate a merchant's export, which is
 * strictly worse than the race it would close.
 *
 * The escalation is not advisory. It is a code path, and
 * `__tests__/request-transaction.test.ts` asserts both lanes by observed
 * event ORDER (commit-before-flush vs flush-before-commit), so a change that
 * silently moves a route between lanes reddens a test.
 *
 * ### In-tx streaming routes today
 *
 * Exactly one: `GET /stores/:storeId/bulk/export.xlsx` (bulk.routes.ts →
 * `streamXlsxResponse`, which does `wb.xlsx.write(res)`). Every other export
 * inside a tenant transaction — bulk CSV, customers .xlsx, orders .xlsx,
 * shipping area-rates .xlsx — builds its payload into memory first and calls
 * `res.send(buffer)`, so it rides the buffered lane and gains commit-before-
 * respond for free. `admin.routes.ts`'s cursor-streamed
 * `GET /admin/export/orders`, finance's and newsletter's `.xlsx` exports run
 * on context-less mounts and never enter a request transaction at all.
 *
 * ## Detached (`void`) work — an unchanged, PRE-EXISTING residual
 *
 * Several in-transaction paths fire best-effort cleanup without awaiting it,
 * through the ambient `prisma` proxy:
 *   - routes: `category.routes.ts` (x2), `typography.routes.ts`,
 *     `store-layout.routes.ts` (`void cleanupRemovedJsonUrls`)
 *   - services reachable from an in-tx route: `variant.service.ts` (x4),
 *     `pages.service.ts` (x2), `blog.service.ts` (x2), `product.service.ts`
 *     (`void cleanupRemovedImages`)
 * all of them `void deleteR2ObjectIfOrphan(...)`-shaped, all already
 * `.catch()`-ing into a warn.
 *
 * Detached DB work has ALWAYS raced this transaction's close — the old
 * middleware committed on `res.on('finish')`, which is a tick or two after
 * `res.json`, not never. Commit-before-respond narrows that window by roughly
 * one event-loop turn; it does not create the race, and a loser logs and skips
 * a cleanup (an orphaned R2 object), it never corrupts a response. The same
 * class was found and FIXED for the one site where it cost money —
 * `OrderService.create`'s affiliate referral link, now awaited (see
 * docs/audits/2026-07-15-rls-enforcement-audit.md Q4).
 *
 * Verified 2026-09-08 by scanning every route file that enters a request
 * transaction: **no handler AWAITS database work after sending its response.**
 * New code must not add one — do the work before responding, await it, or hand
 * it to Inngest. Converting the remaining `void` cleanups to awaited or
 * Inngest work is a separate change; it is a pre-existing leak, not a
 * regression introduced here.
 *
 * ## Post-commit work, and why `open` gets a second argument
 *
 * `deferAfterTenantCommit()` (lib/after-tenant-commit.ts) exists for the work
 * that MUST outlive this transaction — return-confirmation emails, affiliate
 * audit rows, orphaned-R2 cleanup. Each queued task runs in its own FRESH
 * tenant transaction carrying the same GUCs, because a fire-and-forget promise
 * that inherits THIS transaction dies with P2028 the moment it commits.
 *
 * That drain and this module's flush have to be ordered against each other,
 * and neither owns the other. So `open` receives a second argument,
 * `releaseResponse`: "Postgres has answered — the captured bytes may go now."
 * The one canonical order is
 *
 *     COMMIT  →  releaseResponse()  →  drain the deferred tasks
 *
 * - draining BEFORE the flush would put an email send on the client's latency
 *   path (`tests/integration/deferred-work-lifecycle.test.ts` asserts the
 *   response returns while a slow task is still running);
 * - draining before the COMMIT is the P2028 defect itself;
 * - a transaction that ROLLS BACK reaches neither step, and
 *   `withDeferredWork` drops its queued tasks — the rows they would react to
 *   no longer exist.
 *
 * A caller with no post-commit work can ignore `releaseResponse` entirely: the
 * `.then()` at the bottom of this module flushes anyway, one microtask later.
 * Both are safe because `flushCaptured` is idempotent.
 *
 * On the STREAMING lane the sequence is unchanged in shape — the response has
 * already gone out, `releaseResponse()` is a no-op, and the drain still runs
 * after the commit, so streaming exports keep their deferred work.
 */

/**
 * Sentinel: the handler produced a 5xx, so the transaction must ROLL BACK.
 * Thrown INTO the interactive transaction to make Prisma roll it back, then
 * recognised on the way out so the handler's own 5xx response is still the
 * one the client receives. Distinguishing this from a genuine DB/commit
 * failure is what lets a real COMMIT error turn a 2xx into a 500 while an
 * intentional rollback leaves the 500 the handler already wrote intact.
 */
class IntendedRollback extends Error {
  constructor(readonly statusCode: number) {
    super(`Handler returned ${statusCode}`);
    this.name = 'IntendedRollback';
  }
}

/** Which lane this response is in. `flushing` = the gate is done, bytes may go. */
type Lane = 'buffered' | 'streaming' | 'flushing';

/**
 * Headers that describe the response BODY. On a commit failure we discard the
 * handler's captured (successful) body and let the error handler write a JSON
 * 500 instead — these would otherwise survive and mislabel it (a 500 JSON body
 * served as `attachment; filename="orders.csv"`, or with the old body's
 * length). Deliberately narrow: helmet's / securityHeaders' headers, CORS and
 * every `Set-Cookie` are left untouched.
 */
const BODY_DESCRIBING_HEADERS = ['Content-Disposition', 'Content-Length', 'ETag', 'Content-Type'];

/**
 * Wrap one request in an interactive transaction that settles BEFORE the
 * response is sent (buffered lane) or on flush (streaming lane).
 *
 * @param res       the Express response for this request
 * @param next      Express `next` — called to advance into the handler, and
 *                  called with the error on a genuine transaction failure
 * @param open      opens the transaction. Receives (1) the body to run inside
 *                  it and (2) `releaseResponse`, which lets the captured
 *                  response go the instant Postgres has answered. A caller
 *                  with post-commit work MUST call it before starting that
 *                  work; one without can ignore it. Typically
 *                  `(body, release) => withDeferredWork(ctx, () =>
 *                  runInTenantContext(storeId, body, userId), release)`.
 * @param logContext structured fields attached to the failure log
 */
export function runRequestInTransaction(
  res: Response,
  next: NextFunction,
  open: (body: () => Promise<void>, releaseResponse: () => void) => Promise<unknown>,
  logContext: Record<string, unknown>
): void {
  const originalEnd = res.end.bind(res) as (...args: unknown[]) => unknown;
  const originalWrite = res.write.bind(res) as (...args: unknown[]) => boolean;

  let lane: Lane = 'buffered';
  /** Whether the transaction gate has been settled (once only). */
  let settled = false;
  /** Arguments of the deferred `res.end`, held back until the tx settles. */
  let captured: unknown[] | null = null;

  // Assigned when the transaction actually opens and runs its body. They stay
  // undefined if `open()` rejects first — an invalid store id, a `maxWait`
  // timeout, a pool that can't hand out a connection. `res.end` MUST check:
  // deferring a response to a gate that will never be settled hangs the
  // request until the socket times out, which is strictly worse than the
  // defect this module fixes.
  let commit: (() => void) | undefined;
  let rollback: ((err: Error) => void) | undefined;

  /**
   * Move this response out of the buffered lane. Called by every streaming
   * primitive. A no-op once the gate has settled — at that point we are
   * either already flushing a captured response or the client is gone.
   */
  const escalateToStreaming = (): void => {
    if (!settled && lane === 'buffered') lane = 'streaming';
  };

  // `pipe(readable → res)` and `res.sendFile` / `res.download` both reach the
  // socket through `res.write`, so this single hook catches every streaming
  // shape Express can produce. The explicit hooks below exist so the rule is
  // visible at those call sites too, and holds if Express changes internals.
  res.write = function (this: Response, ...args: unknown[]): boolean {
    escalateToStreaming();
    return originalWrite(...args);
  } as Response['write'];

  for (const method of ['download', 'sendFile'] as const) {
    const original = res[method] as ((...args: unknown[]) => void) | undefined;
    if (typeof original !== 'function') continue;
    const bound = original.bind(res) as (...args: unknown[]) => void;
    (res as unknown as Record<string, unknown>)[method] = (...args: unknown[]): void => {
      escalateToStreaming();
      bound(...args);
    };
  }

  if (typeof res.flushHeaders === 'function') {
    const originalFlushHeaders = res.flushHeaders.bind(res);
    res.flushHeaders = (): void => {
      escalateToStreaming();
      originalFlushHeaders();
    };
  }

  res.end = function (this: Response, ...args: unknown[]): Response {
    // Streaming lane, or we are already replaying a captured end / passing an
    // error response through — write straight to the socket.
    if (lane !== 'buffered') {
      originalEnd(...args);
      return this;
    }
    // A second `end()` on an already-captured response: Express does this on
    // some abort paths. The first capture wins; never double-send.
    if (captured) return this;
    // The gate was settled by a client disconnect (`close` without `finish`)
    // before the handler finished. Nothing left to defer to — write it out
    // (a no-op on a destroyed socket) rather than swallowing it.
    if (settled) {
      originalEnd(...args);
      return this;
    }
    // The transaction never opened, so there is no gate to wait on. Write
    // straight through — this is the path the error handler takes after
    // `open()` rejected.
    if (!commit || !rollback) {
      originalEnd(...args);
      return this;
    }

    captured = args;
    settled = true;
    if (res.statusCode >= 500) {
      // 5xx must ROLL BACK — unchanged, load-bearing behaviour. The captured
      // 5xx response is still what the client gets, once the rollback lands.
      rollback(new IntendedRollback(res.statusCode));
    } else {
      commit();
    }
    return this;
  } as Response['end'];

  /** Replay the deferred `res.end` now that Postgres has answered. */
  const flushCaptured = (): void => {
    if (lane === 'flushing' || !captured) return;
    const args = captured;
    lane = 'flushing';
    originalEnd(...args);
  };

  /**
   * Handed to `open` as its second argument — see the "Post-commit work"
   * section at the top of this file. A caller that has work to do after the
   * COMMIT calls this first so the client is not made to wait behind it.
   *
   * Swallow-and-log rather than throw: this runs on the caller's success path,
   * and letting it reject there would look like a transaction failure (the
   * transaction already committed) AND skip the caller's post-commit work.
   */
  const releaseResponse = (): void => {
    try {
      flushCaptured();
    } catch (err) {
      logger.error({ err, ...logContext }, 'Failed to release the deferred response after commit');
    }
  };

  open(
    () =>
      new Promise<void>((resolve, reject) => {
        commit = () => resolve();
        rollback = err => reject(err);

        // Streaming lane fallback (and the safety net for any response that
        // reaches the socket without passing through the patched `end`):
        // settle on flush, exactly as this middleware always did.
        res.on('finish', () => {
          if (settled) return;
          settled = true;
          if (res.statusCode >= 500) reject(new IntendedRollback(res.statusCode));
          else resolve();
        });
        // Premature close (client disconnect) — don't roll back, let the tx
        // commit. Unchanged from the original middleware.
        res.on('close', () => {
          if (settled) return;
          settled = true;
          resolve();
        });

        // Advance into the handler. Passing a function to next() would be a
        // bug — Express treats any truthy argument as an error and skips
        // straight to the error handler.
        try {
          next();
        } catch (err) {
          settled = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }),
    releaseResponse
  )
    .then(() => {
      // COMMITTED (and, for a caller with post-commit work, that work has now
      // drained too). Only now may the bytes go out — a no-op when `open`
      // already released them via `releaseResponse`.
      flushCaptured();
    })
    .catch(err => {
      if (err instanceof IntendedRollback) {
        // Rollback we asked for. The handler's own 5xx is the correct
        // response and is now safe to send.
        flushCaptured();
        return;
      }

      // A genuine transaction failure: COMMIT rejected, statement error,
      // transaction timeout, connection loss.
      if (captured && lane === 'buffered' && !res.headersSent) {
        // THE HEADLINE FIX. The handler's response was never sent, so the
        // client is told the truth: this failed. Previously the 2xx was
        // already on the wire and this branch could do nothing.
        logger.error(
          { err, ...logContext, discardedStatus: res.statusCode },
          'Request transaction failed to commit — response discarded, returning 500'
        );
        captured = null;
        lane = 'flushing';
        for (const header of BODY_DESCRIBING_HEADERS) res.removeHeader(header);
        next(err);
        return;
      }

      if (!res.headersSent) {
        // Nothing was captured (the transaction failed before or without a
        // response) — hand the error to Express. `lane = 'flushing'` first so
        // the error handler's own `res.end` goes straight to the socket
        // instead of being deferred to a gate that will never settle.
        lane = 'flushing';
        logger.error({ err, ...logContext }, 'Request transaction failed');
        next(err);
        return;
      }

      // Streaming lane, response already on the wire — the accepted residual
      // documented at the top of this file. Log it; there is no status line
      // left to change.
      logger.error(
        { err, ...logContext },
        'Request transaction failed after the response was already streamed'
      );
    });
}

/** Test-only export so the rollback sentinel can be asserted by name. */
export const __INTENDED_ROLLBACK_NAME = 'IntendedRollback';
