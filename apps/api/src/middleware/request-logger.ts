import { Request, Response, NextFunction } from 'express';
import logger from '../lib/logger';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const statusCode = res.statusCode;

    // Use appropriate pino log level based on HTTP status code
    const logFn =
      statusCode >= 500
        ? logger.error.bind(logger)
        : statusCode >= 400
          ? logger.warn.bind(logger)
          : logger.info.bind(logger);

    // Include userId + storeId when present so a single request can be
    // correlated end-to-end (auth -> tenant -> route handler -> response).
    // Falls through to undefined fields when the request was anonymous
    // or didn't go through requireStoreAccess. Pino strips undefined.
    logFn(
      {
        method: req.method,
        path: req.path,
        statusCode,
        durationMs: duration,
        userId: req.user?.userId,
        storeId: (req.params?.storeId || req.params?.id) as string | undefined,
        requestId: (req.headers['x-request-id'] as string | undefined) || undefined,
      },
      'request'
    );
  });

  next();
}
