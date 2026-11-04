import {
  UPLOAD_ERROR_FALLBACK,
  UPLOAD_ERROR_MESSAGES,
  VALIDATION_ERROR_MESSAGE,
} from '../lib/localized-error';
import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod/v3';
import { Prisma } from '@ebda/database';
import { isGoldPriceManaged, uniqueViolationTarget } from '../lib/prisma-errors';
import logger from '../lib/logger';
import { redactSensitiveQuery } from '@ebda/shared';

/**
 * A `GoldPriceError` from the shared pricing engine. By name + code, not `instanceof`: the engine is bundled
 * into more than one entry point, and a copy's class is not this module's class (same reason as isZodError).
 */
function isGoldPriceError(err: unknown): err is Error & { code: string } {
  return (
    err instanceof Error &&
    err.name === 'GoldPriceError' &&
    typeof (err as { code?: unknown }).code === 'string'
  );
}

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    // Was `Record<string, string[]>` (the Zod-validation-issues shape,
    // built inline below, never through this constructor). Widened for
    // RULING T9-a: `bundle.routes.ts`'s `price_not_allocatable` 422 needed
    // a structured non-string payload (`{ suggested: <piastres integer> }`)
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
 * A ZodError from ANY zod module instance. `instanceof` alone misses one thrown by a schema built
 * in @ebda/shared when that package resolves a different copy of zod (measured under vitest; the
 * "parseChart dual-zod" class, B0-46), and that error then answered 500. The shape check is the
 * one zod itself documents: name 'ZodError' plus an `issues` array.
 */
export function isZodError(err: unknown): err is ZodError {
  if (err instanceof ZodError) return true;
  return (
    err instanceof Error &&
    err.name === 'ZodError' &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

/**
 * multer's own errors (real multer on Node, the formData stub on workerd: two classes with the
 * same `name` and multer's `code` strings, hence duck typing instead of `instanceof`). They
 * reach `errorHandler` through `next(err)` from any bare `upload.single(...)` / `.array(...)`
 * route, and are the CLIENT's fault: a file over the size cap is a 413, anything else
 * (wrong field, too many files) a 400. Without this mapping every one of them was a 500.
 */
function multerClientError(err: unknown): { status: number; code: string; message: string } | null {
  if (!(err instanceof Error) || err.name !== 'MulterError') return null;
  const code = (err as Error & { code?: unknown }).code;
  if (typeof code !== 'string') return null;
  if (code === 'LIMIT_FILE_SIZE') {
    return { status: 413, code: 'FILE_TOO_LARGE', message: 'The uploaded file is too large' };
  }
  return { status: 400, code, message: err.message };
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
 * got a 400/404/409 — EBDA-API-2C (158 events), 1B, 25, 27 (ZodError from
 * `schema.parse` in public/auth/admin routes) and 2A (duplicate-SKU P2002).
 * Both middlewares now classify through this one function; a parity test
 * (`tests/unit/error-status-parity.test.ts`) pins it to the responses below.
 * Sentry still captures a P2003 / P2025 at WARNING level (issue 1988) — they
 * are answered as client errors but are often server defects (EBDA-API-28).
 */
export function clientErrorStatus(err: unknown): number | undefined {
  if (err instanceof AppError) return err.statusCode < 500 ? err.statusCode : undefined;
  // Ruling B5-13: a writer touched a gold-priced row's price outside the repricer.
  if (isGoldPriceManaged(err) || isGoldPriceError(err)) return 409;
  if (err instanceof SyntaxError && 'body' in err) return 400;
  if (isZodError(err)) return 400;
  const multerErr = multerClientError(err);
  if (multerErr) return multerErr.status;
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') return 409;
    if (err.code === 'P2025') return 404;
    if (err.code === 'P2003') return 400;
  }
  return undefined;
}

/**
 * Mark a Prisma error that a call site KNOWS is a client condition (e.g. a
 * merchant typing a duplicate SKU), so Sentry skips it. See
 * `isExpectedClientError`. Returns the same error for `throw markExpected(e)`.
 */
export function markExpected<E extends Error>(err: E): E {
  (err as E & { expected?: boolean }).expected = true;
  return err;
}

/**
 * Should Sentry treat this as an EXPECTED client error (skip capture)?
 *
 * Narrower than `clientErrorStatus` on purpose (issue 2005). A ZodError, a
 * body-parser SyntaxError and an AppError 4xx are client mistakes by
 * construction. A Prisma P2002/P2025/P2003 is raised by OUR query and is just
 * as often a server defect — EBDA-API-28 was a P2003 from a nested
 * transaction that could not see the uncommitted cart, and a P2002 on a
 * ledger row is a double-post attempt. Those keep their 4xx RESPONSE (the
 * parity with `errorHandler` is unchanged) but are still captured, unless the
 * throw site opted out with `markExpected`.
 */
export function isExpectedClientError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if ((err as { expected?: unknown }).expected === true) return true;
    // Ruling BS-5: a P2002 on a MERCHANT-TYPED unique field (a duplicate SKU
    // or slug) is a genuine client error. Any other P2002 — a ledger/journal
    // row, an idempotency key — is our own double write and is captured
    // (issue 2005).
    if (err.code === 'P2002') {
      const fields = uniqueViolationTarget(err);
      return fields.some(f => MERCHANT_TYPED_UNIQUE_FIELDS.has(f) || /_(sku|slug)_key$/.test(f));
    }
    return false;
  }
  return clientErrorStatus(err) !== undefined;
}

/** Unique columns a merchant types into a form (Ruling BS-5 / CL-5). */
const MERCHANT_TYPED_UNIQUE_FIELDS = new Set(['sku', 'slug']);

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
    logger.error(
      { err, path: redactSensitiveQuery(req.originalUrl) },
      'Error after headers were already sent'
    );
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

  const multerErr = multerClientError(err);
  if (multerErr) {
    logger.debug({ err: { code: multerErr.code, message: err.message } }, 'Multer upload error');
    // E-7: the text is a fixed bilingual sentence, never multer's raw English (which can name the field).
    const bilingual = UPLOAD_ERROR_MESSAGES[multerErr.code] ?? UPLOAD_ERROR_FALLBACK;
    res.status(multerErr.status).json({
      success: false,
      error: {
        code: multerErr.code,
        message: bilingual.messageEn,
        details: bilingual,
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
  if (isZodError(err)) {
    logger.debug({ issues: err.issues }, 'Validation error');
    const details: Record<string, unknown> = {};
    // A duck-typed ZodError (another zod copy) only promises an `issues` array: an issue
    // without a `path` array is filed under the root key, never a 500 (review M-1).
    for (const issue of err.issues as unknown[]) {
      if (!issue || typeof issue !== 'object') continue;
      const { path: rawPath, message } = issue as { path?: unknown; message?: unknown };
      const path = Array.isArray(rawPath) ? rawPath.join('.') : '';
      if (typeof message !== 'string') continue;
      if (!details[path]) {
        details[path] = [];
      }
      (details[path] as string[]).push(message);
    }
    // E-2: the field map stays; the bilingual sentence rides next to it for the admin's localizer.
    Object.assign(details, VALIDATION_ERROR_MESSAGE);

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

  // Ruling B5-13: the database guard `ebda_gold_price_guard` refused a price write on a gold-rate
  // row. The caller's fault (they edited a price the repricer owns), so a 409 with a business message.
  if (isGoldPriceManaged(err)) {
    logger.warn({ requestId }, 'Gold price write refused by the database guard');
    res.status(409).json({
      success: false,
      error: {
        code: 'GOLD_PRICE_MANAGED',
        message:
          "The price of a gold-rate product is calculated from the day's gold rate and cannot be edited by hand.",
        messageAr: 'سعر القطعة بسعر الدهب بيتحسب لوحده من سعر الجرام ومينفعش يتعدّل يدوي.',
        requestId,
      },
    });
    return;
  }

  // Ruling B5-36: a gold price the engine refuses (a rate or spec out of range) is a business 409, not a 500.
  if (isGoldPriceError(err)) {
    logger.warn({ requestId, code: err.code }, 'Gold price refused by the engine');
    res.status(409).json({
      success: false,
      error: {
        code: err.code,
        message: 'This gold price cannot be calculated. Check the rate and the piece details.',
        messageAr: 'مش قادرين نحسب سعر الدهب ده. راجع السعر وتفاصيل القطعة.',
        requestId,
      },
    });
    return;
  }

  // Prisma errors: the FULL detail (code, message, meta — column/constraint
  // names) goes to the SERVER LOG ONLY. The client gets a generic body + the
  // requestId. NEVER return `err.code` (reveals Prisma/Postgres), `err.message`
  // (raw SQL/constraint text), or `err.meta` (schema column/constraint names)
  // to the client — that leaks the internal stack. Support maps requestId →
  // the logged detail. (Ebda internal-data boundary; CLAUDE.md: never
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
      const columns = uniqueViolationTarget(err);
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
