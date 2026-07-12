import { Request, Response, NextFunction } from 'express';
import { runInTenantContext } from '@force/database';
import logger from '../lib/logger';

/**
 * Tenant Context Middleware
 *
 * Wraps the downstream route handler in a Prisma interactive transaction
 * with `SET LOCAL app.current_store_id = '<storeId>'`. This sets the GUC
 * that RLS policies read — but the policies themselves only ENFORCE
 * against the non-bypass `force_app` role. Production currently connects
 * as the `neondb_owner` BYPASSRLS role (see `apps/api/src/index.ts` boot
 * guard), so today this is inert: it is correct-but-inert plumbing ahead
 * of the RLS cutover (see `docs/plans/2026-07-02-rls-cutover.md`), not a
 * live backstop. Tenant isolation today rests entirely on the application
 * layer (`requireStoreAccess` + explicit `where: { storeId }`). Once the
 * cutover flips `DATABASE_URL` to `force_app` and drops
 * `ALLOW_BYPASSRLS_ROLE`, this same wiring becomes a real database-level
 * backstop with zero code changes — that is the point of shipping it now.
 *
 * How it works:
 * 1. Extracts storeId from route params (set by Express route matching —
 *    either from the mount path directly, e.g. `/stores/:storeId/products`,
 *    or via `router.param('storeId', tenantContext)` registered inside a
 *    sub-router whose OWN routes declare `:storeId`, for routers mounted
 *    at a bare prefix like `/stores`)
 * 2. Opens a Prisma $transaction and runs SET LOCAL inside it
 * 3. Stores the transaction client in AsyncLocalStorage
 * 4. Calls next() — all downstream Prisma queries auto-use the transaction
 * 5. When the response finishes, the transaction commits
 *
 * Safety guarantees:
 * - Routes WITHOUT a storeId skip this middleware (no RLS filtering)
 * - If the transaction fails, the error handler returns a clean 500
 * - Existing `where: { storeId }` filters remain as defense-in-depth
 *   (and are the ONLY isolation mechanism until the force_app cutover)
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

  runInTenantContext(
    storeId,
    () => {
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
    },
    // Additive user-scoped GUC (RLS cutover Phase 1b) — sets
    // `app.current_user_id` alongside `app.current_store_id` when the
    // request is authenticated, so user-scoped policies (e.g. `addresses`)
    // can evaluate `user_id = current_user_id()` for requests that happen to
    // flow through a store-scoped route. Undefined for unauthenticated
    // requests — identical to today's behavior (GUC unset → allow-contextless).
    req.user?.userId
  ).catch(err => {
    // Transaction timeout or DB error — let Express error handler deal with it
    // Don't double-send if the response was already started
    if (!res.headersSent) {
      logger.error({ err, storeId }, 'Tenant context transaction failed');
      next(err);
    }
  });
}

/**
 * RLS cutover Phase 1c (docs/plans/2026-07-02-rls-cutover.md) — user-scoped
 * context wrapper for routers that never pass through `tenantContext`.
 *
 * `tenantContext` reads `req.params.storeId || req.params.id`, but Express
 * only populates `req.params` for params declared in the MOUNT path.
 * `address.routes.ts` and `wishlist.routes.ts` are mounted BARE at
 * `/addresses` and `/wishlist` (`routes/index.ts`) with no `:storeId`/`:id`
 * in their mount path at all — addresses are user-scoped with no store_id
 * column, and wishlist reads its store from an `x-store-id` HEADER, not the
 * URL — so `tenantContext` could never reach them even if it were mounted
 * alongside. That left `app.current_user_id` (and, for wishlist,
 * `app.current_store_id`) permanently unset for their traffic, which is
 * FAIL-OPEN (no DB backstop) against the allow-contextless
 * `rls_addresses_user` / `rls_wishlists_tenant` / `rls_wishlist_items_tenant`
 * policies once force_app is live.
 *
 * `userContext(getUserId, getStoreId?)` returns a middleware that:
 *   1. Resolves the authenticated user id via `getUserId(req)` — callers
 *      MUST pass the SAME resolver the router's own handlers use to
 *      determine "the authenticated user" (e.g. `customerUserId` for
 *      wishlist.routes.ts, NOT a bare `req.user?.userId` — the auth cookie
 *      is shared between admin and storefront, and `customerUserId` is the
 *      guard that stops a merchant's userId from being treated as a
 *      customer's). Passing a mismatched resolver would desync the
 *      DB-level filter from the app-layer check.
 *   2. Resolves an optional store id via `getStoreId(req)` (e.g. wishlist's
 *      `x-store-id` header). Silently ignored if absent or not a UUID —
 *      mirrors `tenantContext`'s own non-UUID handling — so a request with
 *      no/garbage store header still gets its user context set instead of
 *      erroring.
 *   3. If no user id resolves (unauthenticated, or a non-customer role on
 *      a customer-only router), skips straight to `next()` with no context
 *      set — identical to `tenantContext`'s "no storeId" branch, and
 *      identical to today's behavior. The router's own `authenticate`
 *      middleware (applied via `router.use(authenticate)` before this) owns
 *      the actual 401; `userContext` never rejects a request itself.
 *
 * INERT on the current bypass role (`neondb_owner`, BYPASSRLS skips every
 * policy) — this wraps handlers in the same interactive-tx pattern the
 * already-wired store-scoped routers use, but changes zero query results
 * until the Phase 3 force_app cutover.
 *
 * Behavior note for the cutover (NOT today): once force_app is live, a
 * cross-user probe (e.g. GET/PUT/DELETE another user's address) that
 * currently 403s at the app-layer ownership check will instead 404 — the
 * RLS policy makes the row invisible to the `findUnique`/`findFirst`
 * BEFORE the ownership check ever runs. This is the DB backstop doing its
 * job (don't reveal existence of another user's row) and is expected. Do
 * not try to preserve the 403 — that would defeat the backstop.
 */
export function userContext(
  getUserId: (req: Request) => string | undefined,
  getStoreId?: (req: Request) => string | null | undefined
) {
  return function (req: Request, res: Response, next: NextFunction): void {
    const userId = getUserId(req);

    // No authenticated (customer) user — nothing to scope. The route's own
    // authenticate/role check still owns the actual 401, identical to
    // today (this middleware never rejects on its own).
    if (!userId) {
      next();
      return;
    }

    const rawStoreId = getStoreId?.(req);
    const storeId = rawStoreId && UUID_RE.test(rawStoreId) ? rawStoreId : undefined;

    runInTenantContext(
      storeId,
      () => {
        return new Promise<void>((resolve, reject) => {
          res.on('finish', () => {
            if (res.statusCode >= 500) {
              reject(new Error(`Handler returned ${res.statusCode}`));
            } else {
              resolve();
            }
          });
          res.on('close', resolve);
          try {
            next();
          } catch (err) {
            reject(err);
          }
        });
      },
      userId
    ).catch(err => {
      if (!res.headersSent) {
        logger.error({ err, userId, storeId }, 'User context transaction failed');
        next(err);
      }
    });
  };
}
