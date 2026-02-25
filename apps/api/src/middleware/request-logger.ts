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

    logFn({ method: req.method, path: req.path, statusCode, durationMs: duration }, 'request');
  });

  next();
}
