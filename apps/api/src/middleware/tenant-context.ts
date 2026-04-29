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
// Mirrors `runInTenantContext`'s guard so we can skip cleanly instead
// of letting it throw. Without this, a request like
// `/stores/public/<uuid>/shipping` first matches the `/stores/:storeId`
// mount with `:storeId="public"`, tenantContext then calls
// `runInTenantContext("public")`, which rejects with "Invalid store ID
// format" → every `/stores/public/...` endpoint surfaced 500. Treating
// non-UUIDs as "no tenant context" lets the request fall through to
// the matching downstream router (which interprets the path itself).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function tenantContext(req: Request, res: Response, next: NextFunction): void {
  const storeId = req.params.storeId || req.params.id;

  // No store context — skip (global routes, super_admin cross-tenant, etc.)
  if (!storeId) {
    next();
    return;
  }

  // Param matched something that isn't a UUID — most commonly the
  // literal `public` from `/stores/public/:storeId/...` URLs that get
  // captured by an earlier `/stores/:storeId` mount. Defer the real
  // tenant scoping to a downstream router.
  if (!UUID_RE.test(storeId)) {
    next();
    return;
  }

  runInTenantContext(storeId, () => {
    return new Promise<void>((resolve, reject) => {
      // When the response finishes, commit on 2xx/3xx/4xx and roll back on 5xx
      // so failed handlers don't leave partial writes behind.
      res.on('finish', () => {
        if (res.statusCode >= 500) {
          reject(new Error(`Handler returned ${res.statusCode}`));
        } else {
          resolve();
        }
      });
      // Premature close (client disconnect) — don't roll back, just let the tx commit.
      res.on('close', resolve);

      // Advance to the next middleware. Passing a function here is a bug:
      // Express treats any truthy argument to next() as an error and skips
      // straight to the error handler, which is why every store-scoped
      // route was returning 500 before the handler ever ran.
      try {
        next();
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
