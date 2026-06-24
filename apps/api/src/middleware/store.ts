import { Request, Response, NextFunction } from 'express';
import { AppError } from './error-handler';

declare module 'express-serve-static-core' {
  interface Request {
    storeId?: string;
  }
}

/**
 * Middleware to extract and validate storeId from route params
 */
export function requireStore(req: Request, _res: Response, next: NextFunction): void {
  const storeId = req.params.storeId;

  if (!storeId) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Store ID is required');
  }

  req.storeId = storeId;
  next();
}
