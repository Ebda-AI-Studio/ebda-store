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
  // Log error
  logger.error({ err }, 'Unhandled error');

  // Handle known errors
  if (err instanceof AppError) {
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

  // Handle Zod validation errors
  if (err instanceof ZodError) {
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
  // Railway log via the `Unhandled error` line above).
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
