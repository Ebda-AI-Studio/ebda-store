import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@force/database';
import logger from '../lib/logger';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    // Was `Record<string, string[]>` (the Zod-validation-issues shape,
    // built inline below, never through this constructor). Widened for
    // RULING T9-a: `bundle.routes.ts`'s `price_not_allocatable` 422 needed
    // a structured non-string payload (`{ suggested: <fils integer> }`)
    // carried through this SAME field rather than inventing a second,
    // bespoke response shape — see that file's `PRICE_NOT_ALLOCATABLE`
    // throws for the first real caller of a non-string-array `details`.
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * The status `errorHandler` below will answer with, for every error class it
 * maps to a CLIENT error (4xx) without that status living on the error object.
 * Returns undefined for anything that becomes a 500.
 *
 * `SentryService.errorHandler()` runs BEFORE `errorHandler` and decides
 * capture from `err.statusCode ?? err.status`. A ZodError, a body-parser
 * SyntaxError and a Prisma P2002/P2025/P2003 carry neither, so every one of
 * them looked like an uncaught crash and was reported even though the client
 * got a 400/404/409 — FORCE-API-2C (158 events), 1B, 25, 27 (ZodError from
 * `schema.parse` in public/auth/admin routes) and 2A (duplicate-SKU P2002).
 * Both middlewares now classify through this one function; a parity test
 * (`tests/unit/error-status-parity.test.ts`) pins it to the responses below.
 */
export function clientErrorStatus(err: unknown): number | undefined {
  if (err instanceof AppError) return err.statusCode < 500 ? err.statusCode : undefined;
  if (err instanceof SyntaxError && 'body' in err) return 400;
  if (err instanceof ZodError) return 400;
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') return 409;
    if (err.code === 'P2025') return 404;
    if (err.code === 'P2003') return 400;
  }
  return undefined;
}

export function errorHandler(err: Error, req: Request, res: Response, next: NextFunction): void {
  // A response has already gone out (a genuine real send — request-
  // transaction.ts's buffered lane flips its lane to 'flushing' the moment
  // it does, at which point ITS res.end override forwards every further
  // call straight to Express's real res.end instead of re-capturing it).
  // Every branch below ends in res.status().json(), which calls res.end()
  // again — on an already-ended response that throws (or corrupts the
  // stream) instead of doing anything useful. Delegate to Express's
  // built-in final handler, the same way Express's own docs say a custom
  // error handler must when headersSent is true.
  if (res.headersSent) {
    logger.error({ err, path: req.originalUrl }, 'Error after headers were already sent');
    next(err);
    return;
  }

  // Correlation id (set by the `requestId` middleware in security.ts). Returned
  // to the client on server-side (5xx) errors so support can map a customer's
  // report to the full server-side detail WITHOUT exposing any internals.
  const requestId = (req.headers['x-request-id'] as string | undefined) || undefined;
  // Log level is decided by error class + status code, NOT a blanket `error`
  // log. AppError 4xx (auth required, validation failed, not found) is
  // EXPECTED behavior — logging those at `error` floods Sentry / BetterStack
  // / Telegram with non-actionable noise + makes "real errors" hard to find.
  //
  // Discipline:
  //   - AppError 4xx → `debug` (visible in dev, silenced in prod)
  //   - AppError 5xx → `error` (genuine server-side AppError throw)
  //   - ZodError → `debug` (validation failure = client mistake)
  //   - Prisma known errors → `error` (DB constraint, missing FK — actionable)
  //   - Anything else (unhandled JS Error / TypeError / etc.) → `error`
  //
  // Matches the project's existing log-level discipline doc
  // (feedback-fire-and-forget-bug-mask + feedback-status-polling-rate-limiter).
  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error({ err }, 'AppError (5xx)');
    } else {
      logger.debug({ err: { code: err.code, message: err.message } }, 'AppError (4xx)');
    }
    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
    return;
  }

  // Handle JSON parse errors from Express body-parser
  if (err instanceof SyntaxError && 'body' in err) {
    logger.debug({ err: { message: err.message } }, 'JSON parse error');
    res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_JSON',
        message: 'Request body contains invalid JSON',
      },
    });
    return;
  }

  // Handle Zod validation errors
  if (err instanceof ZodError) {
    logger.debug({ issues: err.issues }, 'Validation error');
    const details: Record<string, string[]> = {};
    for (const issue of err.issues) {
      const path = issue.path.join('.');
      if (!details[path]) {
        details[path] = [];
      }
      details[path].push(issue.message);
    }

    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details,
      },
    });
    return;
  }

  // Prisma errors: the FULL detail (code, message, meta — column/constraint
  // names) goes to the SERVER LOG ONLY. The client gets a generic body + the
  // requestId. NEVER return `err.code` (reveals Prisma/Postgres), `err.message`
  // (raw SQL/constraint text), or `err.meta` (schema column/constraint names)
  // to the client — that leaks the internal stack. Support maps requestId →
  // the logged detail. (Force AI internal-data boundary; CLAUDE.md: never
  // expose database error messages, codes, hints, or stack traces to clients.)
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    logger.error({ err, requestId }, 'Prisma known request error');

    // A CONSTRAINT VIOLATION IS THE CALLER'S FAULT, NOT A SERVER FAULT.
    // Collapsing every Prisma error into an opaque 500 meant a merchant who
    // typed an SKU another product already uses got "A database error
    // occurred" with no idea what to change — this reached production on a
    // live store (2026-09-02) and was only diagnosable from the Railway logs.
    //
    // We still never echo err.code, err.message or raw meta. `target` is
    // translated through an ALLOWLIST of columns we are willing to name in
    // business terms; anything unrecognised degrades to the generic message,
    // so a new column can never leak by default.
    // IDENTITY-BEARING COLUMNS ARE DELIBERATELY ABSENT.
    //
    // `email` is NOT on this list. auth.routes.ts documents a control (T1-4)
    // that closed registration enumeration: register returns an identical body
    // whether or not the address exists. That control is enforced by a
    // `findFirst` pre-check, which is TOCTOU — two concurrent registrations for
    // the same address race past it and the loser hits the unique index. If
    // this handler answered "that email address is already used", the status
    // code plus message would be exactly the oracle T1-4 removed, on an
    // unauthenticated route. A duplicate email degrades to the generic message
    // instead; an authenticated admin surface that wants a specific error
    // should raise its own AppError, which this global mapper cannot do because
    // it cannot tell a public route from an admin one.
    //
    // `name` is omitted for the same reason (identity-adjacent, and duplicate
    // names are rarely actionable to the caller anyway).
    const FIELD_LABELS: Record<string, string> = {
      sku: 'SKU',
      slug: 'URL slug',
      domain: 'domain',
      code: 'code',
      barcode: 'barcode',
      order_number: 'order number',
    };

    if (err.code === 'P2002') {
      const target = err.meta?.target;
      const columns = Array.isArray(target) ? target.map(String) : [];
      // Ignore tenant-scoping columns — "store_id + sku is taken" is noise to a
      // merchant who only ever operates inside their own store.
      const named = columns
        .filter(c => c !== 'store_id' && c !== 'storeId')
        .map(c => FIELD_LABELS[c])
        .filter((label): label is string => Boolean(label));

      res.status(409).json({
        success: false,
        error: {
          code: 'DUPLICATE_VALUE',
          message: named.length
            ? `That ${named.join(' + ')} is already used by another record. Choose a different one.`
            : 'One of the values you entered is already in use. Choose a different one.',
          requestId,
        },
      });
      return;
    }

    if (err.code === 'P2025') {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'The requested record was not found', requestId },
      });
      return;
    }

    if (err.code === 'P2003') {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REFERENCE',
          message: 'A referenced record does not exist',
          requestId,
        },
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: {
        code: 'DATABASE_ERROR',
        message: 'A database error occurred',
        requestId,
      },
    });
    return;
  }

  // Unknown / unhandled errors: full error (name, message, stack) goes to the
  // SERVER LOG ONLY. The client gets a generic body + the requestId — never the
  // error class name or message (could carry internal stack / connection / SDK
  // detail).
  logger.error({ err, requestId }, 'Unhandled error (5xx)');
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId,
    },
  });
}
