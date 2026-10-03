import { Request, Response, NextFunction } from 'express';
import { runInStoreScope, runInTenantContext } from '@force/database';
import { withDeferredWork } from '../lib/after-tenant-commit';
import { runRequestInTransaction } from './request-transaction';

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
 * 5. The transaction COMMITS BEFORE THE RESPONSE IS SENT. The lifecycle lives
 *    in `./request-transaction.ts` — read its header for the two lanes
 *    (buffered = commit-then-respond; streaming = escalated, still
 *    commit-after-flush) and why the split exists. A 2xx that reaches the
 *    client on the buffered lane is a COMMITTED 2xx; a COMMIT that fails
 *    becomes a 500 the client actually sees, instead of a silent lost write
 *    behind a 201.
 * 6. Work registered by `deferAfterTenantCommit()` drains AFTER that commit
 *    and AFTER the response has been released to the client, each task in its
 *    own FRESH tenant transaction carrying the same GUCs
 *    (`lib/after-tenant-commit.ts`). The full order is
 *    `COMMIT → response → deferred work`, so post-response side effects never
 *    sit on the request's latency path and never inherit a closed transaction.
 *    A rolled-back request drops its deferred work entirely.
 * 7. A client that disconnects before the handler answers ROLLS BACK the
 *    request (issue 1604) — it used to commit whatever half of the handler
 *    had run. See `AbandonedRequest` in `./request-transaction.ts`.
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

/**
 * The tenant scope of the request transaction already open on this response.
 *
 * A request can meet `tenantContext` more than once: the bare-prefix mount
 * `router.use('/stores/:storeId', tenantContext, customersRoutes)` matches
 * EVERY `/stores/<uuid>/*` request, and when its router answers nothing the
 * request falls through to a later mount whose own `router.param('storeId',
 * tenantContext)` opened a SECOND transaction on a second connection (#1602).
 * Since commits gate the response, that meant two serialized COMMITs before
 * the first byte, and a 500 over already-durable writes if the empty outer
 * COMMIT failed. A repeat with the SAME scope now joins the open transaction,
 * so the request is one transaction again. A different scope still opens its
 * own, exactly as before.
 */
const REQUEST_TENANT_SCOPE = Symbol('fwb.requestTenantScope');
type TenantScope = { storeId: string; userId: string | undefined };

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

  // Additive user-scoped GUC (RLS cutover Phase 1b) — sets
  // `app.current_user_id` alongside `app.current_store_id` when the request is
  // authenticated, so user-scoped policies (e.g. `addresses`) can evaluate
  // `user_id = current_user_id()` for requests that happen to flow through a
  // store-scoped route. Undefined for unauthenticated requests — identical to
  // today's behavior (GUC unset → allow-contextless).
  const userId = req.user?.userId;

  const open = (res as unknown as Record<symbol, TenantScope | undefined>)[REQUEST_TENANT_SCOPE];
  if (open && open.storeId === storeId && open.userId === userId) {
    next();
    return;
  }
  (res as unknown as Record<symbol, TenantScope>)[REQUEST_TENANT_SCOPE] = { storeId, userId };

  runRequestInTransaction(
    res,
    next,
    // `withDeferredWork` wraps the TRANSACTION, not the handler: work
    // registered via `deferAfterTenantCommit` runs AFTER the commit, in a
    // fresh tenant transaction carrying the same GUCs. Without it a
    // fire-and-forget promise inherits this (about-to-commit) transaction and
    // its Prisma calls die with P2028 inside a swallowed `.catch`.
    //
    // ORDERING — the whole point of the nesting below:
    //   COMMIT  →  releaseResponse()  →  drain the deferred tasks
    // `releaseResponse` is `runRequestInTransaction`'s own "the bytes may go
    // now" trigger, handed in so the drain cannot get in front of it. Draining
    // BEFORE the flush would put email sends and R2 cleanup on the request's
    // latency path; draining before the COMMIT would reintroduce the P2028
    // this closes. A transaction that rolls back never reaches either step and
    // its queued work is dropped. See lib/after-tenant-commit.ts.
    (body, releaseResponse) =>
      withDeferredWork(
        { storeId, userId },
        () => runInTenantContext(storeId, body, userId),
        releaseResponse
      ),
    { storeId, middleware: 'tenantContext' }
  );
}

/**
 * Store scope for routes that make a SLOW EXTERNAL CALL (an LLM, a payment or
 * domain API) — the alternative to `tenantContext` for them.
 *
 * `tenantContext` holds ONE interactive transaction open from BEGIN until the
 * response is committed, and Prisma expires that transaction 30s after BEGIN
 * no matter what the handler is doing. A handler that awaits a 40-70s Gemini
 * call inside it therefore does its `aiUsage.create` on an expired transaction
 * and its COMMIT fails — FORCE-API-2G: "Transaction already closed … timeout
 * was 30000 ms, however 66772 ms passed", on a request that had already done
 * the work. It also pins a pooled connection idle for the whole call (and
 * `assertAiQuota`'s `withRlsBypass` takes a second one).
 *
 * `runInStoreScope` keeps the RLS scoping and drops the long transaction: every
 * model call / raw query in the handler runs in its OWN short
 * `runInTenantContext(storeId, …)` — the mechanism the bulk-AI Inngest jobs have
 * used since #461. The trade-off is explicit: the request is no longer ONE
 * atomic unit, so only mount this on a router whose handlers do not need
 * all-or-nothing across statements (read, call out, record usage / queue a job).
 *
 * Like `tenantContext`, a request with no usable store id passes straight through.
 */
export function storeScopeContext(req: Request, _res: Response, next: NextFunction): void {
  const storeId = req.params.storeId || req.params.id;
  if (!storeId || !UUID_RE.test(storeId)) {
    next();
    return;
  }
  // `runInStoreScope` types its callback as a Promise. `next()` runs
  // synchronously inside the scope, so every downstream handler (and the async
  // work it starts) inherits it; Express catches a handler's own throw.
  void runInStoreScope(storeId, async () => {
    next();
  });
}

/**
 * The AI router's context, chosen PER REQUEST rather than per router.
 *
 * `/stores/:storeId/ai` holds ~45 routes and only the WRITES await Gemini.
 * Every model call in `routes/ai.routes.ts` sits in a `router.post` handler
 * (`AIService.*`, `generateProductFaqs`, `generateProductMetaAeo`,
 * `fillProductFields`, `balanceProductLanguages`, `revertProductBalance`);
 * every `router.get` there — `/usage/*`, `/results/*`, `/bulk*` — is a pure DB
 * read that touches no third party. So:
 *
 *   - safe method (GET/HEAD) → `tenantContext`: ONE request transaction on ONE
 *     pooled connection, as before.
 *   - everything else → `storeScopeContext`: no long transaction to expire
 *     under a 40-70s model call (FORCE-API-2G, see above).
 *
 * WHY NOT just put the whole router on `storeScopeContext`: under a store scope
 * each awaited query opens its OWN short transaction (`scopedOp` →
 * `runInTenantContext` → `basePrisma.$transaction`, packages/database/src/
 * index.ts), so a read handler's `Promise.all` takes one pooled connection PER
 * QUERY instead of one for the request. `GET /ai/results/seo` fans out 6 queries
 * and the admin AI-tools page fires 9 of those `/results/*` endpoints in a
 * single `Promise.allSettled` on mount — ~30 concurrent transactions against
 * `connection_limit=15` / `pool_timeout=20`. One merchant opening that page
 * would saturate the pod's pool and make unrelated in-flight requests
 * (storefront, checkout, webhooks) queue 20s and fail P2024.
 *
 * WHY NOT a second `router.use('/stores/:storeId/ai', tenantContext, …)` mount
 * for the read paths: an Express `use` mount is a PREFIX match, so it would
 * open the request transaction for the write paths too and they would reach
 * their own mount already inside it — the #1602 fall-through, which
 * `storeScopeContext` cannot undo (the prisma proxy resolves `tenantStorage`
 * before `storeScope`). Dispatching inside the single mount avoids that
 * entirely.
 *
 * Pinned by tests/unit/ai-routes-no-request-transaction.test.ts, which also
 * fails if a GET handler in ai.routes.ts ever reaches a model call.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD']);

export function aiRouteContext(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    tenantContext(req, res, next);
    return;
  }
  storeScopeContext(req, res, next);
}

/**
 * Merchant billing router context (SP5 task 3): reads (GET/HEAD) share ONE
 * request transaction; writes (checkout, change-plan, cancel, resume) call the
 * payment gateway, so they run under a store scope instead — the billing
 * service opens its own short transactions around the claim/settle steps and
 * never holds one across the provider call (CLAUDE.md RLS note).
 */
export function billingRouteContext(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    tenantContext(req, res, next);
    return;
  }
  storeScopeContext(req, res, next);
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

    // Same COMMIT → release → drain ordering as `tenantContext` above; a
    // fire-and-forget promise started by a user-scoped handler inherits this
    // transaction too. See lib/after-tenant-commit.ts.
    runRequestInTransaction(
      res,
      next,
      (body, releaseResponse) =>
        withDeferredWork(
          { storeId, userId },
          () => runInTenantContext(storeId, body, userId),
          releaseResponse
        ),
      { userId, storeId, middleware: 'userContext' }
    );
  };
}
