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

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
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

  // Surface Prisma errors with their underlying code + a short cause.
  // Prisma codes (P2002, P2003, P2025, …) map cleanly to user-facing
  // failure modes — a missing FK target is `P2003`, a unique-constraint
  // violation is `P2002`, etc. Returning the code makes "Internal server
  // error" diagnosable from the storefront console (and Railway log)
  // without exposing the full SQL or stack trace.
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    logger.error({ err }, 'Prisma known request error');
    res.status(500).json({
      success: false,
      error: {
        code: `DB_${err.code}`,
        message: 'Database operation failed',
        // Truncated single-line cause — Prisma's `meta` object usually
        // contains the column / constraint name. Anything longer than
        // 200 chars is internal noise; clip so logs stay readable.
        cause:
          typeof err.message === 'string' ? err.message.split('\n')[0].slice(0, 200) : undefined,
        meta: err.meta,
      },
    });
    return;
  }

  // Handle unknown errors. Include the error's `name` + a clipped
  // message in the response so the storefront / admin console shows
  // SOMETHING actionable instead of just "Internal server error". Stack
  // traces are NOT included in the response (they go only to the
  // Railway log via the `Unhandled error` line below).
  logger.error({ err }, 'Unhandled error (5xx)');
  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      cause:
        err?.name && err?.message
          ? `${err.name}: ${err.message.split('\n')[0].slice(0, 200)}`
          : undefined,
    },
  });
}
