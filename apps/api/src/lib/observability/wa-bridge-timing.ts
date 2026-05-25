import type { Request, Response, NextFunction } from 'express';
import type { Logger } from 'pino';

/**
 * Express middleware that emits a structured log line per request with the
 * full duration (ms) from middleware-enter to response.finish. Used to
 * diagnose the 15s+ wa-bridge latency that prompted Phase 0.
 *
 * Goes between waBridgeAuth and the route handler. Single info line per
 * request — no DEBUG noise.
 */
export const waBridgeTiming =
  (logger: Logger) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
      logger.info(
        {
          path: req.path,
          method: req.method,
          status: res.statusCode,
          durationMs,
          storeId: (req.query.storeId as string | undefined) ?? null,
        },
        'wa-bridge timing'
      );
    });
    next();
  };
