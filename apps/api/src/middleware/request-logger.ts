import { Request, Response, NextFunction } from 'express';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;

    // Color code based on status
    const statusColor =
      res.statusCode >= 500
        ? '\x1b[31m' // Red
        : res.statusCode >= 400
          ? '\x1b[33m' // Yellow
          : '\x1b[32m'; // Green

    console.log(`${statusColor}${req.method}\x1b[0m ${req.path} ${res.statusCode} - ${duration}ms`);
  });

  next();
}
