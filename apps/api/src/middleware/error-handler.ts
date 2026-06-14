import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@force/database';
import logger from '../lib/logger';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: Record<string, string[]>
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
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
