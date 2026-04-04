import { Request, Response, NextFunction } from 'express';
import { runInTenantContext } from '@force/database';
import logger from '../lib/logger';

/**
 * Tenant Context Middleware
 *
 * Wraps the downstream route handler in a Prisma interactive transaction
 * with `SET LOCAL app.current_store_id = '<storeId>'`. This activates
 * Row-Level Security (RLS) policies so the database enforces tenant
 * isolation — even if application code misses a WHERE filter.
 *
 * How it works:
 * 1. Extracts storeId from route params (set by Express route matching)
 * 2. Opens a Prisma $transaction and runs SET LOCAL inside it
 * 3. Stores the transaction client in AsyncLocalStorage
 * 4. Calls next() — all downstream Prisma queries auto-use the transaction
 * 5. When the response finishes, the transaction commits
 *
 * Safety guarantees:
 * - Routes WITHOUT a storeId skip this middleware (no RLS filtering)
 * - If the transaction fails, the error handler returns a clean 500
 * - Existing `where: { storeId }` filters remain as defense-in-depth
 * - Super_admin cross-tenant routes don't pass through this middleware
 * - 30-second transaction timeout prevents long-lived transactions
 */
export function tenantContext(req: Request, res: Response, next: NextFunction): void {
  const storeId = req.params.storeId || req.params.id;

  // No store context — skip (global routes, super_admin cross-tenant, etc.)
  if (!storeId) {
    next();
    return;
  }

  runInTenantContext(storeId, () => {
    return new Promise<void>((resolve, reject) => {
      // Resolve the promise (committing the transaction) when the response is sent
      res.on('finish', resolve);
      // Also resolve on premature close so the transaction doesn't hang
      res.on('close', resolve);

      // Catch synchronous errors from downstream handlers
      try {
        next((err?: unknown) => {
          if (err) reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }).catch(err => {
    // Transaction timeout or DB error — let Express error handler deal with it
    // Don't double-send if the response was already started
    if (!res.headersSent) {
      logger.error({ err, storeId }, 'Tenant context transaction failed');
      next(err);
    }
  });
}
