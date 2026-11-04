import { Request, Response, NextFunction } from 'express';
import { runInStoreScope, runInTenantContext } from '@ebda/database';
import { withDeferredWork } from '../lib/after-tenant-commit';
import { backendFor } from '../lib/store-backend';
import { resolvePublicStoreId } from '../utils/store-helpers';
import { runRequestInTransaction } from './request-transaction';
import { skipsRequestTransaction } from './public-read-limit';
import { authenticateAccounts, liveIdentityMemo } from './auth';
import { isAccountsToken } from '../lib/accounts-token';
import { needsLiveIdentity } from '../lib/auth-sensitivity';
import { recordTiming } from '../lib/request-timing';

/**
 * Tenant Context Middleware
 *
 * Wraps the downstream route handler in a Prisma interactive transaction
 * with `SET LOCAL app.current_store_id = '<storeId>'`. This sets the GUC
 * that RLS policies read — but the policies themselves only ENFORCE
 * against the non-bypass `ebda_app` role. Production currently connects
 * as the `neondb_owner` BYPASSRLS role (see `apps/api/src/index.ts` boot
 * guard), so today this is inert: it is correct-but-inert plumbing ahead
 * of the RLS cutover (see `docs/plans/2026-07-02-rls-cutover.md`), not a
 * live backstop. Tenant isolation today rests entirely on the application
 * layer (`requireStoreAccess` + explicit `where: { storeId }`). Once the
 * cutover flips `DATABASE_URL` to `ebda_app` and drops
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
 *   (and are the ONLY isolation mechanism until the ebda_app cutover)
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
const REQUEST_TENANT_SCOPE = Symbol('ebda.requestTenantScope');
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

  // BE:E-1 (Ruling LAZY-TX-3): an admin-namespace request with NO credential never leases a pooled client. Express runs this param callback BEFORE the
  // route's own `authenticate`, so an anonymous GET/HEAD used to BEGIN a 30 s interactive transaction just to be answered 401.
  // It now takes the per-query store scope (no connection held); the handler's own queries each open a short tenant
  // transaction exactly like `runInStoreScope` callers. Writes keep the transaction (atomicity), and so does every request that
  // carries any credential.
  if (isAnonymousSafeRead(req)) {
    storeScopeContext(req, res, next);
    return;
  }

  (res as unknown as Record<symbol, TenantScope>)[REQUEST_TENANT_SCOPE] = { storeId, userId };

  // BE:E-1: the identity round trips of `authenticate` must NOT happen while a pooled client is leased. Do the live check
  // FIRST (it fills the 30 s single-flight cache, lib/identity-live-cache.ts), so `authenticate` inside the transaction is a
  // cache hit. A failure is ignored here on purpose: `authenticate` owns the 401/403/503 and public routes keep their guest path.
  const credential = bearerToken(req);
  if (credential && isAccountsToken(credential)) {
    preAuthenticate(req, credential)
      .then(() => {
        // The client may have gone while the identity check ran: a transaction opened now would never see `close`.
        if (res.destroyed || res.writableEnded) return;
        openForBackend(req, res, next, storeId, userId);
      })
      .catch(next);
    return;
  }
  openForBackend(req, res, next, storeId, userId);
}

function bearerToken(req: Request): string | undefined {
  const h = req.headers.authorization;
  return h && h.startsWith('Bearer ') ? h.split(' ')[1] : undefined;
}

/**
 * The ADMIN namespace: `/stores/<uuid>/...` (every router that registers `router.param('storeId', tenantContext)`). The public
 * storefront reaches this middleware through `publicStoreContext` under `/public/...`, which is the hot anonymous path and keeps
 * its one-transaction read (Ruling LAZY-TX-1/2), so it is NOT matched here.
 */
const ADMIN_STORE_PATH_RE = /^(?:\/api\/v1)?\/stores\/[0-9a-f-]{36}(?:[/?]|$)/i;

/** An admin-namespace GET/HEAD with no Authorization header and no cookie: nothing downstream can authenticate it. */
function isAnonymousSafeRead(req: Request): boolean {
  const m = req.method.toUpperCase();
  return (
    (m === 'GET' || m === 'HEAD') &&
    !req.user && // an upstream authenticate already ran: not anonymous
    !req.headers.authorization &&
    !req.headers.cookie &&
    ADMIN_STORE_PATH_RE.test(req.originalUrl ?? req.url ?? '')
  );
}

async function preAuthenticate(req: Request, token: string): Promise<void> {
  const timing: { identityMs?: number } = {};
  const start = performance.now();
  try {
    await authenticateAccounts(token, {
      live: needsLiveIdentity(req),
      timing,
      memo: liveIdentityMemo(req),
    });
    recordTiming(req, 'auth', performance.now() - start);
    if (timing.identityMs !== undefined) recordTiming(req, 'identity', timing.identityMs);
  } catch {
    /* authenticate (the route's own) reports it */
  }
}

/**
 * NEON-ZERO-1 (Ruling NZ-TX-1): a store whose backend is `do` has its data in its Durable Object and its platform reads in D1, so
 * the request opens NO Postgres transaction (BEGIN + set_config was a 500 on every admin route with Postgres dead). The flag is
 * the D1 directory column (`backendFor`, the one source); an unreadable flag is a 503, never a Postgres fallback. A `pg` store
 * keeps the request transaction of before.
 */
function openForBackend(
  req: Request,
  res: Response,
  next: NextFunction,
  storeId: string,
  userId: string | undefined
): void {
  backendFor(storeId).then(backend => {
    // The client may have gone while the flag was read: a transaction opened now would never see `close`.
    if (res.destroyed || res.writableEnded) return;
    if (backend === 'do') openDoRequest(res, next, storeId, userId);
    else openTransaction(req, res, next, storeId, userId);
  }, next);
}

/**
 * The same lifecycle as `openTransaction` (response gate, then the deferred drain) with NO Postgres transaction. The scope
 * carries the user, so a `withStore`/`prisma` call a handler still makes on the user-keyed tables (`users`, `addresses`) sees
 * `app.current_user_id` exactly as under the request transaction. Residual (Ruling NZ-TX-1): a leftover Postgres WRITE on a DO
 * request autocommits per query instead of rolling back with the request.
 */
function openDoRequest(
  res: Response,
  next: NextFunction,
  storeId: string,
  userId: string | undefined
): void {
  runRequestInTransaction(
    res,
    next,
    (body, releaseResponse) =>
      withDeferredWork(
        { storeId, userId, noPgTx: true },
        () => runInStoreScope(storeId, body, userId),
        releaseResponse
      ),
    { storeId, middleware: 'tenantContext', backend: 'do' }
  );
}

function openTransaction(
  req: Request,
  res: Response,
  next: NextFunction,
  storeId: string,
  userId: string | undefined
): void {
  const queuedAt = performance.now();
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
        () =>
          runInTenantContext(
            storeId,
            () => {
              // BEGIN done: the time since the request reached this middleware is client lease + BEGIN + SET LOCAL.
              recordTiming(req, 'db-wait', performance.now() - queuedAt);
              return body();
            },
            userId
          ),
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
 * and its COMMIT fails — EBDA-API-2G: "Transaction already closed … timeout
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
 *     under a 40-70s model call (EBDA-API-2G, see above).
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
 * The orders router's context, chosen PER REQUEST (SP6b): everything stays on ONE request
 * transaction except `POST /:orderId/payment-link`, which calls a payment gateway. That one
 * runs under store scope, so the gateway call holds no transaction and no pooled connection:
 * short read, call, then a short transaction to record the payment.
 */
const PAYMENT_LINK_PATH = /^\/[^/]+\/payment-link\/?$/;

export function orderRouteContext(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'POST' && PAYMENT_LINK_PATH.test(req.path)) {
    storeScopeContext(req, res, next);
    return;
  }
  tenantContext(req, res, next);
}

/**
 * The shipping-carrier router's context, chosen PER REQUEST (SP7). Reads stay on ONE request
 * transaction; everything that calls a carrier (booking, cancelling, refreshing tracking, testing
 * credentials, fetching a label) or writes runs under store scope, so a slow courier API holds no
 * transaction and no pooled connection. Registered with `router.param('storeId', ...)` inside the
 * router, because it is mounted at the bare `/stores` prefix (which never sees the param).
 *
 * Before this the router was CONTEXT-LESS: under strict RLS every read returned nothing and every
 * write was rejected, so the carrier settings page and the order shipping actions could not work.
 */
// The label and the carrier's pickup slots (Mylerz) are GETs that call the carrier.
const SHIPPING_EXTERNAL_GET = /^\/[^/]+\/shipments\/[^/]+\/(label|pickup\/windows)\/?$/;

export function shippingCarrierRouteContext(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method) && !SHIPPING_EXTERNAL_GET.test(req.path)) {
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
 * policies once ebda_app is live.
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
 * until the Phase 3 ebda_app cutover.
 *
 * Behavior note for the cutover (NOT today): once ebda_app is live, a
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

    // NEON-ZERO-1 (NZ-TX-1 on top, N-3): a user-scoped request that names a Durable Object store (the storefront wishlist) opens
    // no Postgres transaction either; the scope carries the user. A request with no store keeps the transaction.
    if (storeId) {
      backendFor(storeId).then(backend => {
        if (res.destroyed || res.writableEnded) return;
        if (backend === 'do') openDoRequest(res, next, storeId, userId);
        else openUserTransaction(res, next, storeId, userId);
      }, next);
      return;
    }
    openUserTransaction(res, next, storeId, userId);
  };
}

function openUserTransaction(
  res: Response,
  next: NextFunction,
  storeId: string | undefined,
  userId: string
): void {
  {
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
  }
}

/**
 * Store scope for the PUBLIC (storefront) routes, where the store is not in a
 * `/stores/:storeId` path param but in the `X-Store-ID` / `x-store-domain`
 * headers (or, for a few routes, a UUID first path segment).
 *
 * Under strict RLS a public handler that reads before it is inside a store scope
 * sees no tenant rows at all, so this runs once, at the top of the `/public`
 * mounts, and puts the request in its store's scope:
 *
 *   - GET/HEAD: ONE request transaction (`tenantContext`) — a read-only storefront
 *     request costs one pooled connection, as the design (one transaction per
 *     request) intends;
 *   - everything else: `storeScopeContext` — every query is its own short
 *     transaction, because a write handler may call out (payment gateway, email)
 *     and must not hold a 30s interactive transaction open across it. The same
 *     split as the AI router (`aiRouteContext`).
 *
 * A request that names no resolvable store passes straight through: the handlers
 * that identify the store themselves (`/stores/:slugOrId`, `/store/resolve`, the
 * SMS opt-out) read only the un-scoped `stores` table or enter a scope after
 * they resolve it (`readInStoreContext`), which joins this one when it matches.
 */
const PATH_STORE_RE = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

export function publicStoreContext(req: Request, res: Response, next: NextFunction): void {
  void (async () => {
    let storeId: string | undefined;
    let resolved = false; // true only when the store came from the host/id lookup, never the path
    try {
      storeId = await resolvePublicStoreId(req);
      resolved = Boolean(storeId);
      if (!storeId) {
        const m = PATH_STORE_RE.exec(req.path);
        if (m) storeId = m[1].toLowerCase();
      }
    } catch (err) {
      next(err);
      return;
    }
    if (!storeId) {
      next();
      return;
    }
    // The context middlewares read `req.params.storeId`; Express rewrites
    // `req.params` for every later layer, so setting it here cannot leak.
    req.params = { ...req.params, storeId };
    // Ruling LAZY-TX-1: cached catalogue reads open NO request transaction and no tenant scope.
    // Fail closed: with no ambient scope the tenant guard throws on any tenant-model query and RLS
    // returns nothing, so the only DB access on this path is the handler's own
    // `readInStoreContext` (a short, store-scoped transaction on a cache miss).
    if (resolved && skipsRequestTransaction(req)) next();
    else if (SAFE_METHODS.has(req.method)) tenantContext(req, res, next);
    else storeScopeContext(req, res, next);
  })();
}

/**
 * The payment-settings router's context, chosen PER REQUEST (provider catalog, 2026-10-07): every
 * route stays on ONE request transaction except `POST /store/:storeId/:provider/test`, which calls
 * the payment gateway (Test connection). That one runs under store scope, so the gateway call
 * holds no transaction and no pooled connection: short read, call, short write of the result.
 * Registered with `router.param('storeId', ...)` inside the router.
 */
const PAYMENT_CONNECTION_TEST_PATH = /^\/store\/[^/]+\/[^/]+\/test\/?$/;
/** PUT credentials also calls the gateway now (the automatic check on save, PROVIDERS-3). */
const PAYMENT_CREDENTIALS_PATH = /^\/store\/[^/]+\/[^/]+\/credentials\/?$/;

export function paymentSettingsRouteContext(req: Request, res: Response, next: NextFunction): void {
  if (
    (req.method === 'POST' && PAYMENT_CONNECTION_TEST_PATH.test(req.path)) ||
    (req.method === 'PUT' && PAYMENT_CREDENTIALS_PATH.test(req.path))
  ) {
    storeScopeContext(req, res, next);
    return;
  }
  tenantContext(req, res, next);
}
