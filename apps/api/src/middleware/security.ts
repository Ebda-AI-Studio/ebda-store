import { Request, Response, NextFunction, RequestHandler } from 'express';
import { publicTenantKey } from './public-limiter-keys';
import { isVerifiedCatalogueMiss } from './catalogue-miss';
import rateLimit, {
  ipKeyGenerator,
  MemoryStore,
  type Options,
  type Store,
} from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { createHash, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { isAccountsToken, verifyAccountsToken } from '../lib/accounts-token';
import { redis } from '../services/redis.service';
import { BoundedMap } from '../lib/bounded-map';
import { isWorkers } from '../lib/runtime';
import { CfRateLimitStore } from '../cf/rate-limit-store';
import { withLimitPlan, withoutLimitPlan } from './limit-plan';
import { cfWaitUntil } from '../cf/bindings';
import { isPlatformOrigin } from '../lib/cors-cache';
import { config } from '../config';
import { abuseConfig } from '../lib/abuse-config';
import logger from '../lib/logger';
import {
  recordMemoryFallback,
  recordRateLimited,
  recordSharedCounting,
} from '../lib/rate-limit-telemetry';
import { withSavepoint } from '../lib/savepoint';
import { storeResolveIsNative } from './store-resolve-native';
import { insertAuditLog } from '../lib/definer';
import { currentImpersonator } from '../lib/impersonation-context';

import { JWT_AUDIENCES_ACCEPTED, JWT_ISSUERS_ACCEPTED } from '@ebda/shared';
// ==========================================
// CSRF Protection with Redis + In-Memory Fallback
// ==========================================

// In-memory fallback when Redis is unavailable. BoundedMap caps the entry
// count so the process can never exhaust heap through CSRF token churn
// during a long Redis outage; old sessions are evicted and will re-mint.
const MAX_CSRF_TOKENS = 10000;
const csrfTokensMemory = new BoundedMap<string, { value: string; expiresAt: Date }>(
  MAX_CSRF_TOKENS
);

// Periodic cleanup of expired CSRF tokens. Not on Workers: a timer in global
// scope is a disallowed operation there, an isolate is short-lived, and the
// shared CSRF store is the Durable Object (see cf/ioredis-cf.ts).
if (!isWorkers) {
  setInterval(
    () => {
      const now = new Date();
      for (const [key, value] of csrfTokensMemory) {
        if (value.expiresAt < now) csrfTokensMemory.delete(key);
      }
    },
    5 * 60 * 1000
  ).unref(); // Every 5 minutes. unref: merely importing this module (any script that reaches it through a service) must not keep the process alive.
}

/**
 * Principal a CSRF token is bound to when the minting request had no
 * authenticated user. A literal sentinel (not `''`) so an unbound token can
 * never be produced by a falsy userId slipping through unnoticed.
 */
const ANONYMOUS_CSRF_PRINCIPAL = 'anon';

/**
 * The stored CSRF record is `<principal>.<token>`; only `<token>` is ever
 * handed to the client. Both halves are ids that cannot contain a `.`
 * (cuid / uuid), and the split is on the FIRST separator regardless.
 *
 * WHY THE PRINCIPAL IS STORED AT ALL: without it the token proves only
 * "somebody once minted a token for the session id you are claiming" — and
 * the caller picks its own `X-Session-ID`. An attacker registers a throwaway
 * customer, logs in with `X-Session-ID: <chosen>` (POST /auth/login is exempt
 * from `csrfProtection` and mints for any id the caller supplies), and now
 * holds a (sessionId, csrfToken) pair minted entirely within its OWN session.
 * Hardcoding that pair into a page on its CORS-allowlisted merchant domain
 * and luring a signed-in super_admin makes the browser attach the VICTIM's
 * `SameSite=None` cookie while the attacker supplies both headers — an
 * unbound verifier passes it and the write executes as the victim. Binding
 * the token to the principal that minted it and re-checking against the
 * cookie-derived identity is what makes the double-submit token an actual
 * proof of same-session origin. `restrictPlatformOnlyOrigins` cannot cover
 * this: it only guards `/admin` + `/payment-settings`, while the lured-admin
 * attack lands just as well on every `/stores/:id/*` write.
 */
function packCsrfRecord(principal: string, token: string): string {
  return `${principal}.${token}`;
}

function unpackCsrfRecord(record: string): { principal: string; token: string } | null {
  const sep = record.indexOf('.');
  // No separator = a record written before tokens carried a principal. Fail
  // CLOSED rather than honouring it: those are exactly the unbound tokens the
  // attack above uses, and both frontends re-mint on a `CSRF_*` 403 (refresh
  // + retry once), so a live session heals on its next write instead of
  // carrying the hole for the rest of the 1h TTL.
  if (sep <= 0) return null;
  return { principal: record.slice(0, sep), token: record.slice(sep + 1) };
}

export async function generateCsrfToken(
  sessionId: string,
  userId?: string | null
): Promise<string> {
  const token = randomUUID();
  const record = packCsrfRecord(userId || ANONYMOUS_CSRF_PRINCIPAL, token);
  const ttlSeconds = 3600; // 1 hour

  // Try Redis first
  if (redis.isAvailable()) {
    await redis.setCsrfToken(sessionId, record, ttlSeconds);
  } else {
    // Fallback to in-memory with size limit
    if (csrfTokensMemory.size >= MAX_CSRF_TOKENS) {
      // Evict oldest entries
      const iterator = csrfTokensMemory.keys();
      for (let i = 0; i < 1000; i++) {
        const key = iterator.next().value;
        if (key) csrfTokensMemory.delete(key);
      }
    }
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    csrfTokensMemory.set(sessionId, { value: record, expiresAt });
  }

  return token;
}

/**
 * Identity this request is authenticated as, derived from the access cookie —
 * the only credential a cross-origin attacker can make the browser attach
 * without being able to read it.
 *
 * Read here rather than from `req.user` because `csrfProtection` is mounted
 * app-wide (index.ts), long before any route's `authenticate`. Bearer callers
 * never reach this code (they return early — a header the browser never
 * attaches by itself cannot be ridden).
 */
async function csrfPrincipal(req: Request): Promise<string> {
  const cookieToken = req.cookies?.token as string | undefined;
  if (!cookieToken) return ANONYMOUS_CSRF_PRINCIPAL;

  // Identity-service (ES256) cookie: same rule, signature verified, expiry ignored.
  if (isAccountsToken(cookieToken)) {
    try {
      return (await verifyAccountsToken(cookieToken, { ignoreExpiration: true })).sub;
    } catch {
      return ANONYMOUS_CSRF_PRINCIPAL;
    }
  }

  try {
    const payload = jwt.verify(cookieToken, config.jwtSecret, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUERS_ACCEPTED,
      audience: JWT_AUDIENCES_ACCEPTED,
      // Expiry is `authenticate`'s job, not ours. A 30-minute-old access
      // cookie still identifies its owner unambiguously (the signature is
      // verified), and treating it as anonymous here would turn every
      // just-expired session's next write into a confusing CSRF 403 instead
      // of the 401 that drives the client's silent refresh + retry.
      ignoreExpiration: true,
    }) as { userId?: string };
    return payload.userId || ANONYMOUS_CSRF_PRINCIPAL;
  } catch {
    // Unsigned / tampered / wrong-secret cookie proves no identity.
    return ANONYMOUS_CSRF_PRINCIPAL;
  }
}

async function verifyCsrfToken(
  sessionId: string,
  token: string,
  principal: string
): Promise<boolean> {
  if (!token) return false;

  let record: string | null;
  if (redis.isAvailable()) {
    // Try Redis first
    record = await redis.getCsrfToken(sessionId);
  } else {
    // Fallback to in-memory
    const stored = csrfTokensMemory.get(sessionId);
    if (!stored) return false;

    // Clean up expired tokens
    if (stored.expiresAt < new Date()) {
      csrfTokensMemory.delete(sessionId);
      return false;
    }
    record = stored.value;
  }

  if (!record) return false;

  const unpacked = unpackCsrfRecord(record);
  if (!unpacked) return false;

  // BOTH halves must match: the token proves the caller read a mint response,
  // the principal proves it was minted for the identity this request is
  // authenticated as — not for some throwaway account the attacker controls.
  return unpacked.token === token && unpacked.principal === principal;
}

/**
 * Route prefixes that no merchant-controlled origin may ever reach with the
 * browser's credentials attached. These are the platform-admin and
 * account-destructive surfaces; they are only ever called by the admin app,
 * which is served from a platform origin.
 */
const PLATFORM_ONLY_ORIGIN_PATHS: RegExp[] = [
  /^\/api\/v1\/admin(\/|$)/,
  /^\/api\/v1\/payment-settings(\/|$)/,
  // Everything under /stores/:storeId, minus the storefront allow-list below.
  //
  // routes/index.ts mounts the whole merchant-admin surface here — orders,
  // customers, analytics, finance, suppliers, purchase-orders, shipments,
  // coupons, loyalty, promotions and roughly forty more routers, most at the
  // BARE /stores prefix where each declares its own /:storeId/<segment>. CORS
  // allowlists any DB-registered merchant domain with credentials:true,
  // csrfProtection returns next() for GET, and the cookie is SameSite=None, so
  // a merchant who registers a hostname they control can lure a signed-in
  // admin and read these cross-origin. Store ids are not secret:
  // /public/store/resolve returns one for any storefront domain.
  //
  // This was first written as a DENY-list of enumerated admin segments and
  // that was the wrong direction. The list missed `shipments` (customer names,
  // addresses, phones), `coupons` (full codes and values), `loyalty`,
  // `promotions`, and `/orders/:id/invoice` — the last because the orders
  // pattern deliberately stopped at one segment to spare `/timeline`, which
  // let the admin-only invoice through with the customer's full name, address
  // and line items. A deny-list is only ever as complete as the enumeration
  // behind it, and enumerating forty routers' sub-paths is not a thing anyone
  // will redo when the forty-first is added.
  //
  // So it is inverted: deny the prefix, allow the nine shapes the storefront
  // actually calls. That set is small, comes from ONE app, and is mechanically
  // re-derivable — tests/unit/platform-only-origins.test.ts re-runs the
  // enumeration against apps/web and fails if a storefront call appears that
  // this list does not permit. A missed admin route now fails CLOSED (a 403 on
  // an admin surface, caught immediately) instead of open (silent PII read).
  /^\/api\/v1\/stores(\/|$)/,
];

/**
 * Paths under /stores that a BROWSER on a merchant custom domain legitimately
 * calls. Checked before PLATFORM_ONLY_ORIGIN_PATHS; anything not listed is
 * denied to non-platform origins.
 *
 * Enumerated from apps/web/src — every template-literal request to the bare
 * /stores prefix, excluding /public/stores which this gate never touches.
 * Deliberately exact rather than prefix-shaped: `/reviews/product/:id` is a
 * storefront read, but a hypothetical `/reviews/:id/moderate` is not, and a
 * prefix would hand over both.
 */
const STOREFRONT_ALLOWED_STORE_PATHS: RegExp[] = [
  // The API's OWN public prefix. Several routers mounted at the bare /stores
  // prefix declare their storefront endpoints as `/public/:storeId/...`, which
  // resolve to `/api/v1/stores/public/:storeId/...` — shipping zones, shipping
  // calculate, area rates, coupon validate, promotion preview, loyalty, blog
  // list, locations, pwa config. CheckoutClient and CartClient call every one
  // of those from the BROWSER on a merchant custom domain.
  //
  // The first version of this allow-list missed them entirely, because its
  // patterns all expected a store id as the segment after /stores and these
  // have the literal `public` there. That would have returned 403 on shipping,
  // coupons and promotions for every merchant on a custom domain — checkout
  // unusable — while working perfectly on ebda.app, which is a
  // platform origin and returns early long before this list is consulted.
  // Anchored against a `.` segment so `/stores/public/../<id>/customers`
  // cannot satisfy a bare prefix. A store id never begins with a dot. Belt and
  // braces since #1820: restrictPlatformOnlyOrigins refuses a dot segment
  // ANYWHERE before either list is consulted, and that is the guard the
  // mutation record tracks.
  /^\/api\/v1\/stores\/public\/[^./][^/]*(\/|$)/,
  // Customer order tracking — lib/api.ts getOrderTimeline. NOT the order list,
  // detail or invoice, which are merchant-admin and stay denied.
  /^\/api\/v1\/stores\/[^/]+\/orders\/[^/]+\/timeline\/?$/,
  // Customer returns — app/returns/ReturnsClient.tsx.
  /^\/api\/v1\/stores\/[^/]+\/returns\/?$/,
  // Product reviews: submit, list, eligibility — components/ReviewSection.tsx.
  /^\/api\/v1\/stores\/[^/]+\/reviews\/?$/,
  /^\/api\/v1\/stores\/[^/]+\/reviews\/product\/[^/]+\/?$/,
  /^\/api\/v1\/stores\/[^/]+\/reviews\/can-review\/[^/]+\/?$/,
  //
  // DELIBERATELY NOT LISTED, though an earlier version had them:
  //
  //   /stores/:id/blog/:postId
  //                         This was listed on the strength of
  //                         app/blog/[slug]/BlogPostBody.tsx fetchPost. That
  //                         call is SERVER-side (`next: { revalidate: 60 }`,
  //                         no credentials), so it sends no Origin and never
  //                         reaches this gate — and the route it names is
  //                         `authenticate + authorize(store_admin,
  //                         super_admin, staff) + requireStoreAccess`, the
  //                         ADMIN single-post read that returns drafts. The
  //                         entry therefore bought a merchant origin a
  //                         credentialed cross-origin read of another
  //                         tenant's unpublished posts and bought the
  //                         storefront nothing. Verified against production
  //                         2026-09-13: that path returns 401 unauthenticated
  //                         while `/public/:storeId/blog/:slug` returns a
  //                         clean 404 — fetchPost was calling the wrong
  //                         endpoint and is repointed in the same change.
  //
  //   /stores/:id           store.routes.ts gates GET /:id with authenticate +
  //                         requireMfaEnrolled + authorize(store_admin,
  //                         super_admin) + requireStoreAccess. Its only web
  //                         caller is a SERVER-side fetch (store-resolver.ts
  //                         getStoreById) that sends no cookie and no Origin,
  //                         so it never reaches this gate at all.
  //   /stores/:id/products  product.routes.ts gates GET / the same way and its
  //                         own comment says the storefront uses
  //                         /public/products instead. The apps/web helpers
  //                         getStoreProducts/getStoreProduct are labelled "for
  //                         admin" and have ZERO callers.
  //
  // Both were allow-listed by enumerating string literals in apps/web rather
  // than actual call sites, which let two admin endpoints back through the
  // gate — including product reads carrying costPrice, draft and archived
  // rows, and per-product sold-unit aggregates. A path appearing in a source
  // file is not evidence the storefront calls it.
];

/**
 * Normalize a path to the form Express actually routes on before testing it
 * against `PLATFORM_ONLY_ORIGIN_PATHS`.
 *
 * WHY: the patterns above are a parallel, literal transcription of routes the
 * router matches with `caseSensitive: false` and `strict: false` (both Express
 * defaults). So `GET /api/v1/ADMIN/stores` and `POST /api/v1/auth/logout-all/`
 * reach the real handlers, while a raw case-sensitive, trailing-slash-exact
 * regex test matches NEITHER — the gate falls through to `next()` and a
 * merchant origin gets exactly the credentialed cross-origin read this
 * function exists to deny (GETs never reach the CSRF check).
 *
 * Percent-decoding is belt-and-braces rather than a live bypass: Express 4
 * matches layers against the RAW pathname, so `/api/v1/%61dmin` 404s today.
 * Decoding here can only ever make MORE paths match the deny list (it fails
 * closed) and keeps the gate correct if a proxy or a future router version
 * decodes before matching.
 *
 * That "fails closed" argument holds ONLY while the normalized path feeds a
 * deny-list. It stopped being true the moment an ALLOW-list was checked
 * against the same string: there, decoding makes more paths match a
 * PERMISSION, which fails OPEN — `/api/v1/stores/%70ublic/...` decodes into
 * the storefront prefix and returns next() before the deny pattern is ever
 * reached. `restrictPlatformOnlyOrigins` therefore requires the RAW path and
 * the normalized path to AGREE before it allows anything; see the ordering
 * comment there. Do not reintroduce a lone `gatePath` test on the allow-list.
 */
function normalizePlatformGatePath(rawPath: string): string {
  let path = rawPath;

  // Decode repeatedly — one pass leaves a double-encoded `%2561dmin` encoded.
  for (let i = 0; i < 3; i++) {
    let decoded = path;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      break; // malformed escape (`%zz`) — match on what we have, never throw
    }
    if (decoded === path) break;
    path = decoded;
  }

  // Lowercase (caseSensitive:false), collapse repeated slashes, drop trailing
  // slashes (strict:false) so the anchored `$` patterns still match.
  const collapsed = path.toLowerCase().replace(/\/{2,}/g, '/');

  return collapsed.replace(/\/+$/, '') || '/';
}

/**
 * Refuse credentialed cross-origin access to the platform-admin surface from
 * any origin we do not control.
 *
 * WHY THIS EXISTS SEPARATELY FROM CSRF: `csrfProtection` only guards
 * state-changing methods. CORS runs with `credentials: true` and allowlists
 * every custom merchant domain by DB lookup, so without this a merchant-
 * controlled page could still issue credentialed *GETs* and READ the
 * responses — for a lured super_admin that is every store's data — and could
 * read the response of `POST /admin/impersonate`, which mints a full-privilege
 * token for any user. Requiring a CSRF token closes the write half; this
 * closes the read half.
 *
 * Domain verification is NOT the fix here and must not be mistaken for one:
 * Cloudflare's addDomain creates a custom hostname with no ownership proof, but
 * even a fully DNS-verified merchant domain is still merchant-controlled. Any
 * merchant can buy a real domain. The durable boundary is that the admin
 * surface is reachable only from origins the platform owns.
 *
 * A missing Origin is allowed through: every browser sets Origin on the
 * cross-site credentialed requests this defends against (the API is on a
 * different host from every frontend, so all browser traffic is cross-origin),
 * while server-to-server and CLI callers carry no ambient cookie to abuse.
 */
export function restrictPlatformOnlyOrigins(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin as string | undefined;
  if (!origin) return next();

  if (
    isPlatformOrigin(origin, {
      webUrl: config.webUrl,
      adminUrl: config.adminUrl,
      nodeEnv: config.nodeEnv,
    })
  ) {
    return next();
  }

  const rawPath = req.path;
  const gatePath = normalizePlatformGatePath(rawPath);

  // No `.`/`..` segment, anywhere, on EITHER side of the gate (#1820). The
  // allow-list patterns constrain only the segments they name
  // (`/stores/public/x/../../<id>/customers` satisfied the public prefix), and
  // the deny patterns are tested against a path `normalizePlatformGatePath`
  // does NOT resolve, so `/stores/public/../../admin/impersonate` matched no
  // deny pattern and fell through to next(). Express 4 routes on the
  // unresolved path so both 404 today, but a proxy or router that resolves
  // `..` first would hand a merchant origin the admin surface. No real
  // storefront or admin call contains a whole dot segment, so refuse outright.
  if (hasDotSegment(rawPath) || hasDotSegment(gatePath)) {
    return refuseNonPlatformOrigin(req, res, origin, gatePath);
  }

  // Allow-list FIRST: the storefront's own calls under /stores are permitted,
  // everything else under that prefix is not. Order matters — the deny pattern
  // covers the whole prefix, so checking it first would 403 the storefront.
  //
  // Both forms have to agree. Testing the allow-list against the NORMALIZED
  // path alone inverts the normalizer's own safety argument: decoding may add
  // denials, never permissions, and `/stores/%70ublic/...` decodes straight
  // into the storefront prefix. Requiring the raw path to match too means an
  // encoded variant is refused by the raw test, and a raw path that only
  // LOOKS storefront-shaped until it is decoded is refused by the normalized
  // one. A real storefront call is unencoded and satisfies both.
  // (Dot segments never reach this point — refused above.)
  const storefrontShaped = (candidate: string) =>
    STOREFRONT_ALLOWED_STORE_PATHS.some(pattern => pattern.test(candidate));

  if (storefrontShaped(rawPath) && storefrontShaped(gatePath)) {
    return next();
  }

  if (!PLATFORM_ONLY_ORIGIN_PATHS.some(pattern => pattern.test(gatePath))) {
    return next();
  }

  return refuseNonPlatformOrigin(req, res, origin, gatePath);
}

/** True when any whole path segment is `.` or `..`. */
function hasDotSegment(candidate: string): boolean {
  return candidate.split('/').some(segment => segment === '.' || segment === '..');
}

function refuseNonPlatformOrigin(req: Request, res: Response, origin: string, gatePath: string) {
  logger.warn(
    { origin, path: req.path, gatePath, method: req.method },
    '[SECURITY] blocked non-platform origin on a platform-only route'
  );
  return res.status(403).json({
    success: false,
    error: {
      code: 'ORIGIN_NOT_PERMITTED',
      message: 'This endpoint is not available from this origin',
    },
  });
}

/**
 * The `/auth/` routes exempt from CSRF: exactly the credential-less entry
 * points (the same set the storefront never refreshes on, `NO_REFRESH_AUTH_ROUTES`
 * in apps/web/src/lib/api.ts). Login/register/forgot/reset/verify/resend and
 * the MFA challenge run before a session exists; refresh mints the CSRF token
 * the rest of the API is checked against; logout must work for a session that
 * has lost its token. An exact match on the whole path, not a substring: a new
 * `/auth/...` route is CSRF-checked until someone adds it here on purpose.
 */
const CSRF_EXEMPT_AUTH_PATHS: ReadonlySet<string> = new Set([
  '/api/v1/auth/register',
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
  '/api/v1/auth/logout',
  '/api/v1/auth/forgot-password',
  '/api/v1/auth/reset-password',
  '/api/v1/auth/verify-email',
  '/api/v1/auth/resend-verification',
  '/api/v1/auth/mfa/verify',
  // Passkey sign-in (Ruling PASSKEY-6): credential-less, runs before a session exists. Registration and
  // management are authenticated writes and stay CSRF-checked.
  '/api/v1/auth/passkeys/authenticate/begin',
  '/api/v1/auth/passkeys/authenticate/finish',
  // Self-serve merchant signup (SP5): credential-less entry points reached
  // before any session exists, like register / resend-verification above.
  '/api/v1/auth/merchant/signup',
  '/api/v1/auth/merchant/resend-verification',
]);

export function isCsrfExemptAuthPath(path: string): boolean {
  return CSRF_EXEMPT_AUTH_PATHS.has(path.toLowerCase().replace(/\/+$/, ''));
}

/**
 * True only when cookies were parsed AND neither auth cookie is present. An unparsed `req.cookies` is NOT "no
 * cookie": that case must fall through to the token verifier (the safe direction), never skip it.
 */
function hasNoAuthCookie(req: Request): boolean {
  return !!req.cookies && !req.cookies.token && !req.cookies.refresh_token;
}

export function csrfProtection(req: Request, res: Response, next: NextFunction) {
  // Skip for safe methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Skip for webhook routes (they use HMAC signature verification instead)
  if (req.path.includes('/webhooks/')) {
    return next();
  }

  // Skip for the CREDENTIAL-LESS auth entry points only — the routes a caller
  // reaches before it holds a session, or that mint/clear the CSRF token
  // itself (see CSRF_EXEMPT_AUTH_PATHS). Every other `/auth/` write sits
  // behind `authenticate`, rides the same SameSite=None cookie as any store
  // write, and goes through the full check below.
  //
  // This used to be `req.path.includes('/auth/')`, justified as "auth
  // endpoints use JWT tokens (not session cookies)". That was false for every
  // authenticated one: a merchant custom domain is CORS-allowlisted, so a page
  // on a host the merchant controls could forge a credentialed PUT
  // /auth/me/sms-consent (flip a signed-in shopper's marketing consent), PUT
  // /auth/me, POST /auth/change-password, DELETE /auth/me or POST
  // /auth/logout-all with the victim's cookie (issue 2425).
  if (isCsrfExemptAuthPath(req.path)) {
    return next();
  }

  // Skip for the store-scoped MCP endpoint. MCP clients (Claude, other
  // agents) call `POST /mcp/:storeSlug` as machine-to-machine JSON-RPC —
  // no browser, no cookies, no session to ride. CSRF exists to stop a
  // malicious page silently using a victim's browser session; an MCP
  // client has no session cookie for the attack to hijack. The endpoint
  // is store-resolved + feature-gated (fail-closed 404) in mcp.routes.ts
  // instead. Same class of exemption as the Bearer-token skip below.
  if (req.path.includes('/mcp/')) {
    return next();
  }

  // Skip for public routes. These are unauthenticated endpoints (affiliate
  // apply, contact form, cart operations, etc.) that don't use cookies or
  // sessions, so they are not vulnerable to CSRF. They have their own
  // rate limiting for abuse protection.
  //
  // S2 (2026-11-12 audit): "don't use cookies" is only true when no auth cookie is attached. A signed-in shopper's
  // browser attaches the SameSite=None cookie to `POST /public/orders` from any page, so the skip holds ONLY for
  // a request with no auth cookie (nothing ambient to ride). With a cookie present the request falls through to
  // the Bearer / platform-origin / CSRF-token checks below like any other cookie-authenticated write.
  if (req.path.includes('/public/') && hasNoAuthCookie(req)) {
    return next();
  }

  // Skip for Bearer token authenticated requests. CSRF attacks exploit
  // cookies that the browser attaches automatically. Bearer tokens in the
  // Authorization header are never sent automatically by the browser, so
  // these requests are inherently immune to CSRF.
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return next();
  }

  // OWASP "custom request header" defense — applies when the Origin is
  // a platform origin we control end-to-end.
  //
  // A simple HTML form attack can only forge POSTs with
  // `application/x-www-form-urlencoded` / `multipart/form-data` /
  // `text/plain`. JSON / XHR requests trigger a CORS preflight first,
  // and our CORS config rejects unknown origins — so JSON POSTs from
  // ebda.app (admin / storefront) are inherently safe.
  //
  // CRITICAL: this skip MUST gate on the request's Origin being a
  // PLATFORM origin, not "any allowed origin". Custom merchant domains
  // are also CORS-allowlisted (via DB lookup at runtime), so without
  // the platform-origin gate a malicious merchant could configure
  // `attacker.com` as their store's domain, mount a JSON CSRF page
  // there, and ride the API host's cookie to call any other store's
  // endpoints. Merchant origins therefore fall THROUGH to the
  // CSRF-token verifier below.
  //
  // That fall-through only CATCHES the case because the stored token is
  // bound to the principal it was minted for and re-checked against the
  // cookie-derived identity (see `packCsrfRecord` / `csrfPrincipal`).
  // An unbound verifier would merely compare the caller's own
  // X-Session-ID against a token minted for that same id — both
  // attacker-chosen — so a throwaway customer login would hand the
  // attacker a pair that validates while riding the victim's cookie.
  // Do not drop the principal check believing the origin gate covers it:
  // `restrictPlatformOnlyOrigins` only guards /admin + /payment-settings,
  // and this attack lands on every /stores/:id/* write too.
  //
  // This comment used to sit directly above a condition that did the
  // opposite: `|| isAllowlistedMerchantOrigin(origin)` was added in
  // 619c43e7 (2026-05-14) and made every DB-registered custom domain
  // CSRF-exempt. Cloudflare's addDomain creates a custom hostname with
  // NO ownership proof, so any merchant could register a host they
  // control, lure a logged-in super_admin there, and — with the cookie
  // being SameSite=None and CORS running credentials:true — issue
  // credentialed writes AND read the responses, including a full
  // impersonation token from POST /admin/impersonate. Two audits
  // (2026-07-02 security-surface, 2026-08-31 lens L10) read this
  // comment and graded it PASS without reading the condition.
  //
  // Guest storefront traffic splits in TWO here, and the original version of
  // this comment claimed only the first half existed. It said guest checkout
  // was unaffected because `/public/` paths return early — true for the
  // `/api/v1/stores/public/...` shipping, coupon-validate and promotion-preview
  // calls, which do match the `/public/` early return above. But POST
  // /payments/create is NOT a `/public/` path, so it fell through to the token
  // verifier below, and a guest can never satisfy it: `generateCsrfToken` is
  // reachable only from login and refresh. That sentence cost demo-store.example
  // 17 unpaid orders over two days (2026-09-03 to 09-05).
  //
  // Non-`/public/` guest writes are carried by the cookieless branch further
  // down, NOT by this exemption. Both halves are pinned by
  // docs/security/defence-mutations.json so neither can be widened silently.
  //
  // Anything the storefront POSTs with a RAW fetch — bypassing buildHeaders —
  // now 403s from a merchant custom domain unless its path returns early
  // above or its router is mounted before this middleware in index.ts
  // (/webhooks, /alerts/webhooks, /inngest). That mount order is
  // the only thing exempting them, so a raw write-fetch to one of those paths
  // is one `app.use` reorder away from breaking silently: keep storefront
  // writes on the ApiClient rather than relying on it.
  const contentType = req.headers['content-type'] || '';
  const xRequestedWith = req.headers['x-requested-with'];
  const origin = req.headers.origin as string | undefined;
  const isJsonOrXhr = contentType.includes('application/json') || !!xRequestedWith;
  if (
    isJsonOrXhr &&
    isPlatformOrigin(origin, {
      webUrl: config.webUrl,
      adminUrl: config.adminUrl,
      nodeEnv: config.nodeEnv,
    })
  ) {
    return next();
  }

  // A request carrying no auth cookie has no ambient authority for a
  // cross-origin page to ride. CSRF exists to stop a malicious site making the
  // browser attach a VICTIM's credentials automatically; with no cookie
  // attached there is nothing to hijack, and an attacker could call such an
  // endpoint straight from their own server without a browser at all.
  // `X-Session-ID` cannot substitute: a custom header is never auto-attached,
  // so it can only be set by script that already cleared CORS preflight.
  //
  // This is what carries GUEST checkout on merchant custom domains: POST
  // /payments/create is not a `/public/` path, and a guest never mints a token
  // at all (`generateCsrfToken` runs only on login + refresh). See the fuller
  // account above the platform-origin branch.
  // Both auth-bearing cookies, not just the access one: an access cookie that
  // has been cleared while `refresh_token` survives still represents a session
  // a cross-origin page could try to ride, and treating that as "no credential"
  // would be the narrower claim than the one this branch actually makes.
  //
  // `req.cookies &&` FIRST, deliberately. Without it the optional chaining
  // makes this fail OPEN: when `req.cookies` is undefined — not empty, but
  // never parsed — `!undefined?.token` is true for both, so EVERY
  // state-changing request in the API skips CSRF silently, with no error and
  // no log. That is only prevented today by `cookieParser` being mounted at
  // index.ts:421 ahead of `csrfProtection` at :431. Move either one, or mount
  // this on a router that runs earlier, and the whole gate disappears.
  //
  // With the guard, an unparsed request falls THROUGH to the token verifier
  // instead of being exempted — the safe direction for a request we cannot
  // read the credentials of.
  if (req.cookies && !req.cookies.token && !req.cookies.refresh_token) {
    return next();
  }

  const sessionId = req.headers['x-session-id'] as string;
  const csrfToken = req.headers['x-csrf-token'] as string;

  // Require session ID for state-changing requests without Bearer auth.
  // This protects cookie-based or session-based endpoints from CSRF.
  if (!sessionId) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'CSRF_MISSING_SESSION',
        message: 'Session ID required for state-changing requests',
      },
    });
  }

  // Always verify the CSRF token for state-changing requests (POST/PUT/PATCH/DELETE).
  // Previously this check was only applied when an Authorization header was present,
  // which left unauthenticated state-changing endpoints unprotected.
  csrfPrincipal(req)
    .then(principal => verifyCsrfToken(sessionId, csrfToken, principal))
    .then(valid => {
      if (!valid) {
        res.status(403).json({
          success: false,
          error: { code: 'CSRF_INVALID', message: 'Invalid CSRF token' },
        });
        return;
      }
      next();
    })
    .catch(() => {
      // Fail closed - reject the request when CSRF verification itself errors
      res.status(403).json({
        success: false,
        error: { code: 'CSRF_ERROR', message: 'CSRF validation failed' },
      });
    });
}

// ==========================================
// Rate Limiting (per-route)
// ==========================================

// ---------------------------------------------------------------------------
// Redis-backed rate-limit store (F8)
// ---------------------------------------------------------------------------

/**
 * Minimal ioredis shape rate-limit-redis needs: a raw `call(...)`.
 * `any[]` (not `unknown[]`) on purpose: ioredis's overloaded `call` has a
 * `string`-first signature that is contravariantly incompatible with an
 * `unknown[]` param, so the real client wouldn't be assignable. `any[]` makes
 * the param bivariant — the single SDK-shim seam for the redis store.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RedisCaller = { call: (...args: any[]) => unknown };

/**
 * Resolves the Redis client a rate limiter should use for THIS request, or
 * null when Redis is not connected right now.
 *
 * Gated on `isAvailable()` (connected), not merely on a client object
 * existing: ioredis queues commands on a client that is still connecting or
 * reconnecting, and `maxRetriesPerRequest: 3` would hold the request for
 * seconds before failing. A limiter must never make a request wait on Redis.
 */
// pq-allow(unused-export): imported by tests/unit/rate-limit-redis-at-boot.test.ts
export const rateLimitRedisClient = (): RedisCaller | null =>
  rateLimitSharedEnabled() && redis.isAvailable() ? redis.getClient() : null;

/**
 * Kill switch for SHARED counting (issue 2230 / issue 2171). `RATE_LIMIT_SHARED=0`
 * puts every limiter back on per-process counting without a code change —
 * the escape hatch if the shared (tighter, by the replica count) budgets turn
 * out too small for real traffic. Read per request. Default: shared.
 */
export function rateLimitSharedEnabled(): boolean {
  return process.env.RATE_LIMIT_SHARED !== '0';
}

/**
 * A rate-limit store that picks its backend PER REQUEST (#1862).
 *
 * Every limiter in this file is built at module load, and this module is
 * imported (via `./routes`) before `redis.connect()` has run — so reading
 * `redis.getClient()` at construction time returned null for every limiter,
 * and each one silently counted in a per-process MemoryStore in production:
 * reset on every deploy, multiplied by the replica count (F8).
 *
 * This store defers the decision to the request: when Redis is connected it
 * delegates to a `RedisStore` (built on first use, rebuilt if the client
 * object changes); when it is not — during boot, or a mid-life outage — it
 * counts in a local MemoryStore, so the request is served immediately and is
 * still limited per process. It never waits on Redis and never throws on
 * Redis's absence; a Redis COMMAND error still propagates to the limiter,
 * where the fail-open `passOnStoreError` flag serves the request.
 */
class RedisOrMemoryStore implements Store {
  readonly prefix: string;
  // Keys are shared across replicas whenever Redis is up.
  readonly localKeys = false;
  // Workers: counters live in the AuthState Durable Object (exact, shared by every
  // isolate). No MemoryStore there: it starts a timer at init, which workerd forbids
  // in global scope, and a per-isolate count is worthless on an ephemeral isolate.
  private readonly memory = isWorkers ? undefined : new MemoryStore();
  private readonly cfStore: CfRateLimitStore | undefined;
  private redisStore: RedisStore | undefined;
  private redisStoreClient: RedisCaller | undefined;
  private options: Options | undefined;

  constructor(
    private readonly resolveClient: () => RedisCaller | null | undefined,
    name: string
  ) {
    this.prefix = `rl:${name}:`;
    if (isWorkers) this.cfStore = new CfRateLimitStore(this.prefix);
  }

  init(options: Options): void {
    this.options = options;
    this.memory?.init(options);
    this.cfStore?.init(options);
  }

  private current(): Store {
    if (this.cfStore) {
      recordSharedCounting();
      return this.cfStore;
    }
    const memory = this.memory as MemoryStore;
    const client = this.resolveClient();
    if (!client) {
      // issue 1963: never silent — counted, summarised, alerted once.
      recordMemoryFallback(
        this.prefix,
        rateLimitSharedEnabled() ? 'redis-unavailable' : 'disabled'
      );
      return memory;
    }
    recordSharedCounting();
    if (!this.redisStore || this.redisStoreClient !== client) {
      const store = new RedisStore({
        sendCommand: (...args: string[]) => client.call(...args) as Promise<number | string>,
        prefix: this.prefix,
      });
      // RedisStore loads its Lua scripts from its constructor and never
      // handles those promises; a failed load is retried inside increment/get,
      // so mark them handled here instead of leaking an unhandledRejection.
      store.incrementScriptSha.catch(() => undefined);
      store.getScriptSha.catch(() => undefined);
      if (this.options) store.init(this.options);
      this.redisStore = store;
      this.redisStoreClient = client;
    }
    return this.redisStore;
  }

  get(key: string) {
    return this.current().get?.(key);
  }

  async increment(key: string) {
    const result = await this.current().increment(key);
    // A hit past the limit is a 429 (issue 2216): count it per limiter so the
    // shared-budget tightening is measured, not inferred.
    const limit = this.options?.limit;
    if (typeof limit === 'number' && result.totalHits > limit) recordRateLimited(this.prefix);
    return result;
  }

  decrement(key: string) {
    return this.current().decrement(key);
  }

  resetKey(key: string) {
    return this.current().resetKey(key);
  }
}

/**
 * Build the store for an express-rate-limit limiter so limits are shared
 * across all API replicas (F8) whenever Redis is connected. Pass a RESOLVER
 * (`rateLimitRedisClient`), never `redis.getClient()` evaluated at module load
 * — that is exactly the null-at-import defect in #1862. A plain client object
 * is accepted for tests.
 */
export function makeRateLimitStore(
  redisClient: RedisCaller | null | undefined | (() => RedisCaller | null | undefined),
  prefix: string
): Store {
  const resolve =
    typeof redisClient === 'function'
      ? (redisClient as () => RedisCaller | null | undefined)
      : () => redisClient;
  return new RedisOrMemoryStore(resolve, prefix);
}

type PlannedRateLimitOptions = Omit<
  Partial<Options>,
  'store' | 'keyGenerator' | 'skip' | 'windowMs'
> & {
  windowMs: number;
  keyGenerator?: (req: Request) => string;
  skip?: (req: Request) => boolean;
  /** The key reads `req.body` (the request-level prefetch then predicts it from the parsed, sanitised body). */
  keyReadsBody?: boolean;
};

/**
 * PERF-BATCH-1 (Ruling PERF-BATCH-1): an express-rate-limit limiter on the `rl:<name>:` store that also declares its plan
 * (middleware/limit-plan.ts), built from the SAME options object: name, window, key function and skip predicate. The
 * request-level prefetch (middleware/request-limit-prefetch.ts) reads the plan to send this limiter's hit in the request's ONE
 * batched AuthState call per shard; the limiter then takes the prefetched result instead of its own round trip. Limit, window,
 * key, headers, 429 body and fail mode (Ruling API-HANG-2) are the limiter's own, unchanged. With no `keyGenerator` the
 * limiter keeps express-rate-limit's default (client IP, IPv6 /56) and the plan uses the same `ipKeyGenerator(ip, 56)`.
 */
export function plannedRateLimit(name: string, opts: PlannedRateLimitOptions): RequestHandler {
  const { keyReadsBody, ...options } = opts;
  const limiter = rateLimit({ ...options, store: makeRateLimitStore(rateLimitRedisClient, name) });
  return withLimitPlan(limiter, {
    name,
    windowMs: opts.windowMs,
    key: req =>
      opts.keyGenerator ? opts.keyGenerator(req) : req.ip ? ipKeyGenerator(req.ip, 56) : null,
    skip: req => opts.skip?.(req) ?? false,
    body: keyReadsBody,
  });
}

// Strict limiter for auth endpoints.
//
// Two-layer brute-force defense: this 15-attempt window is the
// IP+email request budget, and the account-lockout service in
// auth.service.ts fires at 5 wrong-password attempts for the same
// email. The limiter exists to bound RAW request volume (helmet against
// credential-stuffing storms hammering the same login endpoint), not
// to be the primary brute-force gate — that's account-lockout.
//
// Previously hardcoded `max: 5`, which collided with the lockout-at-5
// boundary: the 6th request to verify the lock-out response was
// always RATE_LIMITED instead of ACCOUNT_LOCKED. 15 gives the test a
// margin and still drops a credential-stuffing attacker quickly.
//
// Tests skip the limiter entirely via `skip: () => isTestEnv` —
// integration / e2e suites need to fire many auth requests in
// sequence and rely on lockout behavior without the rate-limit
// trip-wire firing first.
const isTestEnv = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

// Shared skip predicate for load-test bypass. Active only when
// LOAD_TEST_BYPASS_TOKEN is set on the host AND the request carries
// a matching `x-load-test-token` header. Production traffic is
// rate-limited as usual whenever the env var is unset (default).
const skipForLoadTest = (req: Request): boolean => {
  const expected = process.env.LOAD_TEST_BYPASS_TOKEN;
  if (!expected) return false;
  return req.header('x-load-test-token') === expected;
};
const skipForLoadTestOrTests = (req: Request): boolean => isTestEnv || skipForLoadTest(req);
/**
 * The authLimiter bucket: client IP (IPv6 normalised to its /64, so rotating the
 * low 64 bits is not a fresh bucket — ERR_ERL_KEY_GEN_IPV6) plus the submitted
 * email. Exported for the same reason as `resetEmailLimiterKey`: every limiter
 * is skipped under vitest, so a test can only see a 429 by building the limiter
 * with the skip turned off.
 */
export function authLimiterKey(req: Request): string {
  const email = req.body?.email || 'unknown';
  return `${ipKeyGenerator(req.ip ?? '')}-${email}`;
}

export function createAuthLimiter(opts?: { skip?: (req: Request) => boolean; prefix?: string }) {
  return plannedRateLimit(opts?.prefix ?? 'auth', {
    keyReadsBody: true,
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 15,
    message: {
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many login attempts, please try again later.' },
    },
    standardHeaders: true,
    legacyHeaders: false,
    // Fail-OPEN on a Redis store error (deliberate availability-over-strictness
    // tradeoff, adversarial audit P2): express-rate-limit v8 defaults this to
    // false, which rethrew a Redis blip into a 500 on every limited route —
    // Redis became a single point of failure for the whole write surface while
    // the cache layer deliberately fails open. Unlimited-but-up beats down.
    passOnStoreError: true,
    skip: opts?.skip ?? skipForLoadTestOrTests,
    keyGenerator: authLimiterKey,
  });
}

export const authLimiter = createAuthLimiter();

/**
 * LAUNCH-RL: the IP-wide half of the credential gates. `authLimiter` buckets on IP + the submitted
 * email, so an attacker rotating the email (credential stuffing, signup spam, reset-mail bombing
 * across many addresses) gets a fresh bucket per request. This bucket is the client IP alone
 * (IPv6 -> /64). `countSuccess: false` counts only failed (>= 400) responses, so a shared office or
 * carrier NAT with many honest sign-ins is not locked out; mail/account-creating routes use
 * `countSuccess: true` because their success is the abuse. Exact: counted on the AuthState DO.
 */
/**
 * LAUNCH-RL fail-safe: on the Worker `req.ip` is the CF-Connecting-IP Cloudflare saw (worker.ts rewrites X-Forwarded-For to it,
 * `trust proxy` 1). With no resolvable IP the new per-IP limiters do NOT count, rather than pooling every such request in one
 * shared bucket that would throttle all shoppers at once.
 */
const noClientIp = (req: Request): boolean => !req.ip;

export function createAuthIpLimiter(opts: {
  countSuccess: boolean;
  max?: number;
  prefix?: string;
  skip?: (req: Request) => boolean;
}) {
  return plannedRateLimit(opts.prefix ?? 'auth-ip', {
    windowMs: 15 * 60 * 1000,
    max: opts.max ?? (opts.countSuccess ? 30 : 60),
    message: {
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many attempts from this network, try again later.',
      },
    },
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
    skipSuccessfulRequests: !opts.countSuccess,
    skip: req => noClientIp(req) || (opts.skip ?? skipForLoadTestOrTests)(req),
    keyGenerator: req => ipKeyGenerator(req.ip ?? ''),
  });
}
/** Sign-in style routes (login, MFA verify, reset-password, change-password): failures only. */
export const authIpFailureLimiter = createAuthIpLimiter({
  countSuccess: false,
  prefix: 'auth-ip-fail',
});
/** Account/mail-creating routes (register, forgot-password, resend-verification): every request. */
export const authIpAllLimiter = createAuthIpLimiter({ countSuccess: true, prefix: 'auth-ip-all' });

/**
 * LAUNCH-RL: unknown-store lookups. Every storefront request resolves host/slug -> store; a miss is
 * a database round trip an attacker can repeat for free with random slugs/hosts. Counts ONLY 404s
 * (a hit is free and stays under the general public limiter), 20 misses/min per IP.
 *
 * LAUNCH-RL-MISS (Ruling LAUNCH-RL-MISS-1): this is deliberately NOT express-rate-limit's `skipSuccessfulRequests`. That
 * mode counts EVERY request up front and gives the hit back after the response, so a request that is not a miss still spent
 * the miss budget: (a) while in flight (30 parallel 200s from one IP on workerd: 10 answered 429), and (b) for the rest of
 * the minute whenever the give-back, which runs after the response, did not land on the Worker (production 2026-11-09: seven
 * sequential 200s took `ratelimit-remaining` from 19 to 14). Shoppers behind one carrier NAT share the IP.
 *
 * Here a request only READS the miss count (20 already: 429, same body and headers as before) and a miss is counted after
 * its 404 was sent, kept alive past the response with `waitUntil`. A response that is not a 404 never writes the counter.
 * The RateLimit headers carry the misses left BEFORE this response, so they are flat across hits and fall across misses.
 * A counter outage serves the request (fail open), as every limiter here does: a read that throws counts as no misses,
 * and a miss is still written afterwards, so the count is right again once the counter can be read. A store with no `get`
 * (express-rate-limit declares it optional) cannot be read at all and so never refuses; every store built here has one
 * (`makeRateLimitStore`), and the workerd test proves the production store is read (the 21st miss is a 429).
 *
 * Reading then counting is not atomic: misses already in flight when the budget runs out are still answered, so a burst
 * can pass the limit by its own concurrency. The atomic per-IP public limiter in front of it bounds that.
 *
 * LAUNCH-RL-MISS-3: every 404 is a miss EXCEPT a dead product or blog link inside a store the resolver verified
 * (`isVerifiedCatalogueMiss`, middleware/catalogue-miss.ts: verified-store flag AND listed route AND same store id).
 * Counting those let ordinary browsing of one real store, or the storefront's server render of it, lock the IP out of
 * the whole public router. An unknown store, an unmatched route and every other route's 404 stay counted, no marker.
 */
export function createStoreMissLimiter(opts?: {
  skip?: (req: Request) => boolean;
  max?: number;
  /** Tests only: the counter store (a failing or slow one). */
  store?: Store;
}): RequestHandler {
  const windowMs = 60 * 1000;
  const max = opts?.max ?? 20;
  const store = opts?.store ?? makeRateLimitStore(rateLimitRedisClient, 'store-miss');
  // No `limit`: the store's own over-limit telemetry stays quiet, the 429 below is what is recorded.
  void store.init?.({ windowMs } as Options);
  const skip = (req: Request) => noClientIp(req) || (opts?.skip ?? skipForLoadTest)(req);
  const message = {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
  };
  return async (req, res, next) => {
    if (skip(req)) return next();
    // Store resolve on the native limiters (Ruling PERF-AUTHSTATE-1): the miss is counted lazily, on the 404 path, by the handler.
    if (storeResolveIsNative(req)) return next();
    const key = ipKeyGenerator(req.ip ?? '');
    let misses = 0;
    let resetAt = 0;
    try {
      const info = await store.get?.(key);
      const until = info?.resetTime?.getTime() ?? 0;
      // an in-memory store can still hold a window that has ended
      if (info && (!until || until > Date.now())) {
        misses = info.totalHits;
        resetAt = until;
      }
    } catch {
      // fail open: the miss is still counted below when the counter is back
    }
    const resetSeconds = Math.max(
      1,
      Math.ceil(((resetAt || Date.now() + windowMs) - Date.now()) / 1000)
    );
    if (!res.headersSent) {
      res.setHeader('RateLimit-Policy', `${max};w=${windowMs / 1000}`);
      res.setHeader('RateLimit-Limit', String(max));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, max - misses)));
      res.setHeader('RateLimit-Reset', String(resetSeconds));
    }
    if (misses >= max) {
      recordRateLimited('rl:store-miss:');
      res.setHeader('Retry-After', String(resetSeconds));
      res.status(429).send(message);
      return;
    }
    res.once('finish', () => {
      if (res.statusCode !== 404) return;
      // LAUNCH-RL-MISS-3: a dead product or blog link inside a store the resolver verified is not store probing
      if (isVerifiedCatalogueMiss(req, res)) return;
      // after the response: `cfWaitUntil` keeps the count alive on a Worker and swallows a store error
      cfWaitUntil(Promise.resolve().then(() => store.increment(key)));
    });
    next();
  };
}
export const storeMissLimiter = createStoreMissLimiter();

/**
 * LAUNCH-RL: storefront search + typeahead run LIKE/embedding queries per call and shared the
 * 300/min general bucket with cached reads. 60/min per IP: typeahead debounces to a few per second
 * at most; a script does not.
 */
export function createPublicSearchLimiter(opts?: {
  skip?: (req: Request) => boolean;
  max?: number;
}) {
  return plannedRateLimit('public-search', {
    windowMs: 60 * 1000,
    max: opts?.max ?? 60,
    message: {
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many searches, please slow down.' },
    },
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
    skip: req => noClientIp(req) || (opts?.skip ?? skipForLoadTest)(req),
    keyGenerator: req => ipKeyGenerator(req.ip ?? ''),
  });
}
export const publicSearchLimiter = createPublicSearchLimiter();
/** Whether a request carries a search term (the `whenSearching` condition; also read by the public limit prefetch). */
export function hasSearchTerm(req: Request): boolean {
  return (
    req.headers['x-search-query'] !== undefined ||
    (typeof req.query?.search === 'string' && req.query.search.trim() !== '')
  );
}

/** Applies a search limiter only when the request actually carries a search term. */
export function whenSearching(limiter: RequestHandler): RequestHandler {
  return (req, res, next) => (hasSearchTerm(req) ? limiter(req, res, next) : next());
}

/**
 * Passkey sign-in (Ruling PASSKEY-6) takes NO email, so `authLimiter`'s IP+email key would collapse every
 * attempt from an IP into one `<ip>-unknown` bucket shared with login — and conditional-UI autofill calls
 * /begin on every login page load. Two IP-only buckets instead: /begin is cheap (one Redis write) and
 * generous; /finish is the guessable surface (a signature has to verify) and counts FAILURES only.
 * Exported with their key function for the same reason as `authLimiterKey`: every limiter is skipped
 * under vitest, so a test can only see a 429 by building one with the skip turned off.
 */
export function passkeyLimiterKey(req: Request): string {
  return `${ipKeyGenerator(req.ip ?? '')}-passkey`;
}

/**
 * Sign-in start is cheap (one Redis write) and the real brute-force guard is the account lockout, so its
 * bucket is generous and is split by store host (review M3): a mobile-carrier NAT full of shoppers of one
 * store cannot lock out another store's shoppers, nor the admin.
 */
export function passkeyBeginLimiterKey(req: Request): string {
  let host = 'none';
  try {
    host = new URL(String(req.headers?.origin ?? '')).host.toLowerCase().slice(0, 100) || 'none';
  } catch {
    host = 'none';
  }
  return `${ipKeyGenerator(req.ip ?? '')}-${host}-passkey-begin`;
}

export function createPasskeyLimiter(
  kind: 'begin' | 'finish',
  opts?: { skip?: (req: Request) => boolean }
) {
  return plannedRateLimit(`passkey-${kind}`, {
    windowMs: 15 * 60 * 1000,
    max: kind === 'begin' ? 300 : 20,
    skipSuccessfulRequests: kind === 'finish',
    message: {
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many attempts, please try again later.' },
    },
    standardHeaders: true,
    legacyHeaders: false,
    // Same availability-over-strictness posture as authLimiter.
    passOnStoreError: true,
    skip: opts?.skip ?? skipForLoadTestOrTests,
    keyGenerator: kind === 'begin' ? passkeyBeginLimiterKey : passkeyLimiterKey,
  });
}
/**
 * Step-up (PASSKEY-7) is an AUTHENTICATED call, so its bucket is the authenticated user (review M2):
 * `authLimiter` keys on `req.body.email`, which an attacker rotates for a fresh bucket per request. The
 * shared lockout counter stays the real guard against password guessing; this bounds the request rate.
 */
export function passkeyStepUpLimiterKey(req: Request): string {
  return `stepup-${req.user?.userId ?? ipKeyGenerator(req.ip ?? '')}`;
}

export function createPasskeyStepUpLimiter(opts?: { skip?: (req: Request) => boolean }) {
  return withoutLimitPlan(
    rateLimit({
      store: makeRateLimitStore(rateLimitRedisClient, 'passkey-stepup'),
      windowMs: 15 * 60 * 1000,
      max: 10,
      message: {
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many attempts, please try again later.' },
      },
      standardHeaders: true,
      legacyHeaders: false,
      passOnStoreError: true,
      skip: opts?.skip ?? skipForLoadTestOrTests,
      keyGenerator: passkeyStepUpLimiterKey,
    }),
    'keyed on req.user (set by authenticate, after the request-level prefetch)'
  );
}
export const passkeyBeginLimiter = createPasskeyLimiter('begin');
export const passkeyFinishLimiter = createPasskeyLimiter('finish');
export const passkeyStepUpLimiter = createPasskeyStepUpLimiter();

/**
 * Exported so it can be unit-tested directly (same reasoning as
 * `refreshLimiterKey` above): `skipForLoadTestOrTests` disables every
 * limiter under vitest, so a suite that only drove the route could never
 * observe a 429 and would pass against a bucket that does not exist.
 *
 * Normalises the email (trim + lowercase) so `A@x.com` and `a@x.com ` share
 * a budget, and has NO IP component — the whole point is to bound this
 * account regardless of how many source IPs a flood comes from.
 */
export function resetEmailLimiterKey(req: Request): string {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  // Scoped by the tenant the request names (#1861). An account is
  // `authScope(email, storeId)`, so one email is a DISTINCT account in each
  // store; a single `reset-<email>` bucket let a flood aimed at store A lock
  // password recovery for the same address on store B (and on the platform
  // admin). Rotating `storeId` cannot widen the flood to one inbox: a store
  // where that email has no account sends nothing. Capped so a caller cannot
  // mint arbitrarily long Redis keys.
  const storeId =
    typeof req.body?.storeId === 'string' && req.body.storeId.trim()
      ? req.body.storeId.trim().toLowerCase().slice(0, 64)
      : 'platform';
  return `reset-email-${storeId}-${email || 'unknown'}`;
}

/**
 * S5-3 (2026-09-22 security audit), `/forgot-password` only.
 *
 * `authLimiter` bounds this route too (15/15min per IP+email), but that
 * budget is sized for credential-stuffing request VOLUME, not for reset-
 * EMAIL flooding — 15 reset emails to one inbox in 15 minutes is still
 * within it. This is a second, tighter, account-scoped budget stacked in
 * front of `authLimiter`, keyed on the normalised email alone (no IP
 * component) so rotating source IPs cannot reopen it.
 *
 * AVAILABILITY TRADEOFF (#1861), stated because the flooding side is only half
 * of it: an IP-independent account budget is symmetric — the account's owner
 * cannot get a fresh bucket either. Anyone who knows an address can spend its
 * 3/hour and the owner's own request then 429s. Two things bound that: the key
 * is per tenant (above), so a flood can only lock the one account it targets;
 * and the flood itself mails the owner a working reset link each time (links
 * live 15 minutes and are not invalidated by later requests), so recovery is
 * delayed to "use the link already in your inbox", not removed.
 *
 * Not applied to `/reset-password` (the confirm step): that request body is
 * `{ token, password }` — it carries no email to key on, and `authLimiter`
 * already bounds it (IP + the literal string "unknown", since
 * `req.body?.email` is absent) at 15/15min/IP.
 */
export function createResetEmailLimiter(opts?: {
  skip?: (req: Request) => boolean;
  prefix?: string;
}) {
  return plannedRateLimit(opts?.prefix ?? 'reset-email', {
    keyReadsBody: true,
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 3,
    message: {
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many password reset requests for this account, please try again later.',
      },
    },
    standardHeaders: true,
    legacyHeaders: false,
    // Same availability-over-strictness posture as the other auth limiters.
    passOnStoreError: true,
    skip: opts?.skip ?? skipForLoadTestOrTests,
    keyGenerator: resetEmailLimiterKey,
  });
}

export const resetEmailLimiter = createResetEmailLimiter();

/**
 * Address-wide ceiling on account emails to ONE inbox (issue 2228), stacked in
 * front of the per-tenant `resetEmailLimiter` on `/forgot-password` and on
 * `/resend-verification` (which had only the IP-rotatable `authLimiter`).
 *
 * The per-tenant key (#1861) is right for fairness, but an address holds one
 * account PER STORE, and store ids are public — so spraying every known store
 * id multiplied the per-inbox budget by the number of accounts that address
 * holds: 3/hour × N reset mails to the same mailbox, plus Resend cost and
 * sender-reputation damage on merchant domains. This bucket has no IP and no
 * store component, so neither rotating IPs nor rotating store ids widens it.
 *
 * Tradeoff (Ruling S1-8, amended by CL-6): a flood can now spend the owner's
 * address-wide budget across every store; each flooded request still mailed
 * a working 15-minute link, so recovery is "use the link already in your
 * inbox", not removed.
 */
export function authEmailAddressLimiterKey(req: Request): string {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  return `auth-email-any-${email.slice(0, 320) || 'unknown'}`;
}

export const authEmailAddressLimiter = plannedRateLimit('auth-email-any', {
  keyReadsBody: true,
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 6,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many emails requested for this address, please try again later.',
    },
  },
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
  skip: skipForLoadTestOrTests,
  keyGenerator: authEmailAddressLimiterKey,
});

/**
 * Rate-limit bucket for `POST /auth/verify-email`.
 *
 * S5-4 (2026-09-22) put this route behind `authLimiter` for consistency with
 * the rest of this router, but `authLimiter`'s key is
 * `<ip>-<req.body.email || 'unknown'>` and this route posts only `{ token }`
 * — no email — so every verification click from one IP pooled into the SAME
 * `<ip>-unknown` bucket `authLimiter` already gives `/reset-password`. Ruling
 * P2-B2-3 deliberately keeps THAT pooling for `/reset-password` +
 * `/mfa/verify`: low-volume, single-account, credential-guessing surfaces.
 * `/verify-email` isn't one — the token is a 256-bit hash (brute force is
 * infeasible; see the S5-4 comment above) — and this platform is
 * multi-tenant, so shoppers on DIFFERENT stores sharing one egress IP (a
 * Egypt mobile carrier, an office/retail wifi) pooled into one budget. The
 * 16th person to click a perfectly valid verification link in 15 minutes got
 * 429'd with `authLimiter`'s "Too many login attempts" message (#1863).
 *
 * A dedicated store namespace (`makeRateLimitStore`'s `prefix` scopes Redis
 * keys per limiter) un-pools this from `/reset-password` entirely, and the
 * budget is sized for shared-IP signup bursts rather than credential-
 * stuffing volume. Kept IP-only rather than keyed on the presented token:
 * the token is not verified before this middleware runs, so keying on it
 * would let an attacker mint an unlimited number of fresh buckets just by
 * varying the string — the bucket-shopping mistake Ruling P2-B2-6 records
 * for an unverified `jwt.decode`.
 *
 * Exported so it can be unit-tested directly (same reasoning as
 * `resetEmailLimiterKey`/`refreshLimiterKey` above): every limiter is
 * disabled under vitest (`skipForLoadTestOrTests`), so a bug in the key is
 * structurally invisible to any suite that only drives the route over HTTP.
 */
export function verifyEmailLimiterKey(req: Request): string {
  return `verify-email-${ipKeyGenerator(req.ip ?? '')}`;
}

export const verifyEmailLimiter = plannedRateLimit('verify-email', {
  keyReadsBody: true,
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many verification attempts, please try again later.',
    },
  },
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
  skip: skipForLoadTestOrTests,
  keyGenerator: verifyEmailLimiterKey,
});

/**
 * Per-IP bucket for the public merchant signup + resend routes (SP5).
 *
 * Signup creates a user row and sends mail, so it needs a volume cap that
 * `authLimiter` (sized for login guessing, keyed IP+email) does not give:
 * rotating the email field would mint a fresh bucket every request. This key
 * is IP-only. 20/hour is generous for a shared Egyptian mobile-carrier egress
 * IP yet stops a signup-spam loop; the per-ADDRESS mail cap is
 * `authEmailAddressLimiter`, stacked on the same routes.
 *
 * `createMerchantSignupIpLimiter` is a factory so a test can build one that is
 * NOT skipped under vitest (every shared limiter is) and observe a real 429.
 */
export function merchantSignupIpLimiterKey(req: Request): string {
  return `merchant-signup-${ipKeyGenerator(req.ip ?? '')}`;
}

export function createMerchantSignupIpLimiter(opts?: {
  skip?: (req: Request) => boolean;
  max?: number;
  prefix?: string;
}) {
  return plannedRateLimit(opts?.prefix ?? 'merchant-signup-ip', {
    windowMs: 60 * 60 * 1000,
    max: opts?.max ?? 20,
    message: {
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many signups from this network, try again later.',
      },
    },
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
    skip: opts?.skip ?? skipForLoadTestOrTests,
    keyGenerator: merchantSignupIpLimiterKey,
  });
}

export const merchantSignupIpLimiter = createMerchantSignupIpLimiter();

/**
 * Signup VELOCITY (SP5 task 4), on `POST /auth/merchant/signup` only (the resend
 * route keeps the shared budget above):
 *
 *   - per IP:  `SIGNUP_IP_PER_HOUR` (default 5)
 *   - per /24: `SIGNUP_SUBNET_PER_HOUR` (default 20) - an IPv4 /24 (IPv6 /64)
 *     is one household / office / small VPS block, so rotating the last octet
 *     does not mint a fresh budget.
 *
 * Keys ignore the body (rotating the email must not help). Both are factories
 * so a test can build ones that are NOT skipped under vitest.
 */
export function signupSubnetKey(ipRaw: string | undefined): string {
  const ip = (ipRaw ?? '').replace(/^::ffff:/i, '');
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  return `${ipKeyGenerator(ip, 64)}`;
}

function signupVelocityLimiter(opts: {
  prefix: string;
  max: () => number;
  key: (req: Request) => string;
  message: string;
  skip?: (req: Request) => boolean;
}) {
  return plannedRateLimit(opts.prefix, {
    windowMs: 60 * 60 * 1000,
    max: opts.max,
    message: { success: false, error: { code: 'RATE_LIMITED', message: opts.message } },
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
    skip: opts.skip ?? skipForLoadTestOrTests,
    keyGenerator: opts.key,
    // The subnet key folds IPv6 itself (signupSubnetKey -> ipKeyGenerator /64);
    // the library's source-text check cannot see through that helper.
    validate: { keyGeneratorIpFallback: false },
  });
}

export function createSignupIpVelocityLimiter(opts?: {
  skip?: (req: Request) => boolean;
  prefix?: string;
  max?: () => number;
}) {
  return signupVelocityLimiter({
    prefix: opts?.prefix ?? 'merchant-signup-ip-h',
    max: opts?.max ?? (() => abuseConfig.signupIpPerHour()),
    key: req => `signup-ip-${ipKeyGenerator(req.ip ?? '')}`,
    message: 'Too many signups from this network, try again later.',
    skip: opts?.skip,
  });
}

export function createSignupSubnetVelocityLimiter(opts?: {
  skip?: (req: Request) => boolean;
  prefix?: string;
  max?: () => number;
}) {
  return signupVelocityLimiter({
    prefix: opts?.prefix ?? 'merchant-signup-net-h',
    max: opts?.max ?? (() => abuseConfig.signupSubnetPerHour()),
    key: req => `signup-net-${signupSubnetKey(req.ip)}`,
    message: 'Too many signups from this network, try again later.',
    skip: opts?.skip,
  });
}

export const merchantSignupIpVelocityLimiter = createSignupIpVelocityLimiter();
export const merchantSignupSubnetVelocityLimiter = createSignupSubnetVelocityLimiter();

/**
 * Upper bound on a string we are willing to run an HMAC over in the refresh
 * key generator. Refresh JWTs are ~300-500 bytes; 4096 is generous headroom.
 */
const MAX_REFRESH_TOKEN_CHARS = 4096;

/**
 * Rate-limit bucket for `POST /auth/refresh`.
 *
 * Exported so it can be unit-tested directly. The limiters are disabled in
 * tests (`skipForLoadTestOrTests` is `isTestEnv || …`), so a bug in the key is
 * structurally invisible to any suite that drives the route — the only way to
 * cover it is to execute the key function itself.
 *
 * `/auth/refresh` used to ride `authLimiter`, whose key is
 * `<ip>-<req.body.email>`. A refresh body is `{}` or `{refreshToken}` and
 * never carries an email, so every refresh from an IP collapsed into ONE
 * bucket, `<ip>-unknown`, shared with `/mfa/verify` and the password-reset
 * confirm routes — which are emailless for the same reason. Measured in
 * production on 2026-09-10: 46 sessions for one user refreshing in a single
 * second after a deploy. Fifteen succeeded; the rest got 429, and both
 * clients treat a non-ok refresh as a dead session, so the user was logged
 * out of every tab — the exact symptom the rotation-race work exists to
 * remove, arriving through a different door.
 *
 * The key is the presented token's subject, scoped by IP. What the subject
 * buys is that one user's open tabs share a budget instead of every user
 * behind a NAT sharing one.
 *
 * THE SUBJECT IS TAKEN FROM A *VERIFIED* TOKEN ONLY. `jwt.decode` would read
 * `sub` out of an unsigned blob the caller composed, and for a rate limiter
 * that is fatal even though a bucket is not a capability: the attacker would
 * be choosing the partition, so a loop posting `jwt.sign({}, 'x', {subject:
 * randomUUID()})` mints a fresh 120-per-15-min bucket per request and is never
 * throttled. (Each of those also used to cost an unauthenticated Neon round
 * trip, because the route hashed and queried before any signature check; the
 * route now verifies first via `verifyRefreshJwt` — #1801.)
 * Verification is a single HMAC (microseconds) and cannot be forged, so
 * bucket cardinality is bounded by real issued sessions. Anything that does
 * not verify — garbage, wrong secret, expired, oversized — shares the strict
 * `anon` bucket per IP, which is what a brute-force attempt looks like anyway.
 */
export function refreshLimiterKey(req: Request): string {
  const presented =
    (typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : undefined) ??
    (typeof req.cookies?.refresh_token === 'string' ? req.cookies.refresh_token : undefined);

  let subject = 'anon';
  // Unverifiable token -> shared anonymous bucket. Deliberately silent: this
  // runs before the route, and the route produces the 401.
  const verified = verifyRefreshJwt(presented);
  if (verified && typeof verified.sub === 'string') {
    subject = verified.sub;
  }

  return `${ipKeyGenerator(req.ip ?? '')}-refresh-${subject}`;
}

/**
 * Verify a presented refresh token's SIGNATURE (HS256, ebda-api/ebda-app)
 * and return its payload, or null for anything that does not verify. One
 * helper for the limiter key above and the `/auth/refresh` route (#1801), so
 * the two cannot drift.
 *
 * Length ceiling before any crypto: bodies are accepted up to 10mb, and
 * HMAC-ing a 10mb "token" once per request is itself the amplifier. A real
 * refresh JWT is a few hundred bytes.
 *
 * `ignoreExpiration` exists for the ROUTE: there the DB row's `expiresAt` is
 * the authority on lifetime (`AuthService.refreshTokens` enforces it), and the
 * JWT's own `exp` follows `REFRESH_TOKEN_EXPIRES_IN`, which may be shorter than
 * the row. Gating the route on `exp` would sign out sessions that refresh
 * today. The limiter keeps the stricter reading (expired -> anon bucket).
 */
export function verifyRefreshJwt(
  presented: unknown,
  opts: { ignoreExpiration?: boolean } = {}
): jwt.JwtPayload | null {
  if (typeof presented !== 'string' || !presented) return null;
  if (presented.length > MAX_REFRESH_TOKEN_CHARS) return null;
  try {
    const verified = jwt.verify(presented, config.jwtSecret, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUERS_ACCEPTED,
      audience: JWT_AUDIENCES_ACCEPTED,
      ignoreExpiration: opts.ignoreExpiration === true,
    });
    return verified && typeof verified === 'object' ? verified : null;
  } catch {
    return null;
  }
}

/**
 * `/auth/refresh` only. Sized to real multi-tab behaviour rather than to
 * credential stuffing: a merchant with the admin PWA, the orders PWA and a
 * handful of browser tabs refreshes tens of times an hour in normal use, and
 * every one of those is a request the user did not make and cannot see fail.
 * Credential stuffing is what `authLimiter` is for, and /refresh is no longer
 * in its bucket.
 */
export const refreshLimiter = plannedRateLimit('refresh', {
  keyReadsBody: true,
  windowMs: 15 * 60 * 1000,
  max: 120,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many refresh attempts, please try again later.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Same availability-over-strictness posture as the other limiters: a Redis
  // blip must not 500 the path every open tab uses to stay signed in.
  passOnStoreError: true,
  skip: skipForLoadTestOrTests,
  keyGenerator: refreshLimiterKey,
});

/**
 * Per-IP backstop for `POST /auth/refresh`, stacked in FRONT of
 * `refreshLimiter`.
 *
 * `refreshLimiter` partitions by subject, so its ceiling is
 * 120 × (distinct subjects seen from this IP). Verifying the token bounds that
 * cardinality to genuinely issued sessions, but it does not make it a constant
 * — and `skipGlobalRateLimit` bypass 3 removed the IP-wide mutation cap this
 * route used to also ride. Without something IP-wide, the only ceiling left is
 * attacker-influenced. This is that ceiling.
 *
 * 600/15min is deliberately far above real use (an access token lives 30
 * minutes, so a tab refreshes ~1-2× per window) and still well above the
 * 200/15min global mutation cap /refresh sat under before the bypass, so no
 * office NAT that worked yesterday starts 429-ing today.
 */
export const refreshIpLimiter = plannedRateLimit('refresh-ip', {
  windowMs: 15 * 60 * 1000,
  max: 600,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many refresh attempts, please try again later.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Same availability-over-strictness posture as the other limiters.
  passOnStoreError: true,
  skip: skipForLoadTestOrTests,
  keyGenerator: req => `${ipKeyGenerator(req.ip ?? '')}-refresh-ip`,
});

// Limiter for API writes (orders, payments)
export const writeLimiter = plannedRateLimit('write', {
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 writes per minute
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Fail-OPEN on a Redis store error (deliberate availability-over-strictness
  // tradeoff, adversarial audit P2): express-rate-limit v8 defaults this to
  // false, which rethrew a Redis blip into a 500 on every limited route —
  // Redis became a single point of failure for the whole write surface while
  // the cache layer deliberately fails open. Unlimited-but-up beats down.
  passOnStoreError: true,
  skip: skipForLoadTest,
});

// Admin ⌘K record lookup (GET /stores/:storeId/search). GETs skip the global limiter, and each
// request runs three store-scoped lookups, so it needs its own: per USER (a store's staff share one
// office IP), generous for typing (the palette debounces to ~5/s at most) and a hard stop for a
// held key or a script. A merchant who hits it sees a distinct "slow down" state in the palette.
export const ADMIN_SEARCH_LIMIT_PER_MINUTE = 120;
export const adminSearchLimiter = withoutLimitPlan(
  rateLimit({
    store: makeRateLimitStore(rateLimitRedisClient, 'admin-search'),
    windowMs: 60 * 1000,
    max: ADMIN_SEARCH_LIMIT_PER_MINUTE,
    message: {
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many searches, please slow down.' },
    },
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
    skip: skipForLoadTest,
    keyGenerator: req => `admin-search-${req.user?.userId ?? ipKeyGenerator(req.ip ?? '')}`,
  }),
  'keyed on req.user (set by authenticate, after the request-level prefetch)'
);

// Stricter limiter for payment operations
export const paymentLimiter = plannedRateLimit('payment', {
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 payment attempts per minute
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many payment attempts, please wait.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Fail-OPEN on a Redis store error (deliberate availability-over-strictness
  // tradeoff, adversarial audit P2): express-rate-limit v8 defaults this to
  // false, which rethrew a Redis blip into a 500 on every limited route —
  // Redis became a single point of failure for the whole write surface while
  // the cache layer deliberately fails open. Unlimited-but-up beats down.
  passOnStoreError: true,
  skip: skipForLoadTest,
});

// File upload limiter - more restrictive
export const uploadLimiter = withoutLimitPlan(
  rateLimit({
    store: makeRateLimitStore(rateLimitRedisClient, 'upload'),
    windowMs: 60 * 1000, // 1 minute
    max: 20, // 20 uploads per minute
    message: {
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many upload requests, please slow down.' },
    },
    standardHeaders: true,
    legacyHeaders: false,
    // Fail-OPEN on a Redis store error (deliberate availability-over-strictness
    // tradeoff, adversarial audit P2): express-rate-limit v8 defaults this to
    // false, which rethrew a Redis blip into a 500 on every limited route —
    // Redis became a single point of failure for the whole write surface while
    // the cache layer deliberately fails open. Unlimited-but-up beats down.
    passOnStoreError: true,
    skip: skipForLoadTest,
    keyGenerator: req => {
      // Limit per user, not per IP. ipKeyGenerator() applied to the IP
      // fallback so anonymous IPv6 callers can't bypass via lower-64-bit
      // rotation (ERR_ERL_KEY_GEN_IPV6).
      return req.user?.userId || ipKeyGenerator(req.ip ?? '') || 'anonymous';
    },
  }),
  'keyed on req.user (set by authenticate, after the request-level prefetch)'
);

// Catalogue import: uploads per STORE per hour (a staff pile-on or a looping client cannot spend a
// store's AI budget). Keyed on the store from the route, never the body. The page ledger and the
// active-jobs cap are the money-side limits; this is the request-rate side.
export const catalogImportStoreLimiter = plannedRateLimit('catalog-import-store', {
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.CATALOG_IMPORT_UPLOADS_PER_HOUR || '10', 10),
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many imports this hour, try again later.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
  skip: skipForLoadTest,
  keyGenerator: req => `store:${req.params.storeId || 'unknown'}`,
  validate: { keyGeneratorIpFallback: false },
});

// Daily upload limit per user
export const dailyUploadLimiter = withoutLimitPlan(
  rateLimit({
    store: makeRateLimitStore(rateLimitRedisClient, 'upload-daily'),
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    max: 500, // 500 uploads per day per user
    message: {
      success: false,
      error: { code: 'DAILY_LIMIT', message: 'Daily upload limit reached. Try again tomorrow.' },
    },
    standardHeaders: true,
    legacyHeaders: false,
    // Fail-OPEN on a Redis store error (deliberate availability-over-strictness
    // tradeoff, adversarial audit P2): express-rate-limit v8 defaults this to
    // false, which rethrew a Redis blip into a 500 on every limited route —
    // Redis became a single point of failure for the whole write surface while
    // the cache layer deliberately fails open. Unlimited-but-up beats down.
    passOnStoreError: true,
    skip: skipForLoadTest,
    keyGenerator: req => {
      // ipKeyGenerator() normalizes IPv6 to /64 prefix (ERR_ERL_KEY_GEN_IPV6).
      return req.user?.userId || ipKeyGenerator(req.ip ?? '') || 'anonymous';
    },
  }),
  'keyed on req.user (set by authenticate, after the request-level prefetch)'
);

// Public API rate limiter - protect public endpoints from abuse
export const publicLimiter = plannedRateLimit('public', {
  windowMs: 60 * 1000, // 1 minute
  // Storefront browsing burns through this fast on real mobile sessions:
  // home + Next.js App Router RSC prefetches on link hover/viewport entry +
  // product-list pagination + category filters easily clear 60 req/min on
  // a routine browse. Mobile audit on 2026-05-13 reproduced the "Too many
  // requests" banner during a normal customer flow. 300/min (~5/sec) is
  // generous for human use + RSC fanout while still tripping on bots
  // (typically >10/sec).
  max: 300,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Fail-OPEN on a Redis store error (deliberate availability-over-strictness
  // tradeoff, adversarial audit P2): express-rate-limit v8 defaults this to
  // false, which rethrew a Redis blip into a 500 on every limited route —
  // Redis became a single point of failure for the whole write surface while
  // the cache layer deliberately fails open. Unlimited-but-up beats down.
  passOnStoreError: true,
  // Ruling RL-SSR-IP-6: an explicit per-address key, and no address = not counted (the `noClientIp` convention) rather than
  // every such request pooling in one bucket that would throttle all shoppers at once.
  skip: req => noClientIp(req) || skipForLoadTest(req),
  keyGenerator: req => ipKeyGenerator(req.ip ?? ''),
});

// Store resolver rate limiter - stricter for domain resolution
export const storeResolveLimiter = plannedRateLimit('store-resolve', {
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many store resolution requests.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Fail-OPEN on a Redis store error (deliberate availability-over-strictness
  // tradeoff, adversarial audit P2): express-rate-limit v8 defaults this to
  // false, which rethrew a Redis blip into a 500 on every limited route —
  // Redis became a single point of failure for the whole write surface while
  // the cache layer deliberately fails open. Unlimited-but-up beats down.
  passOnStoreError: true,
  // Ruling RL-SSR-IP-6: an explicit per-address key, and no address = not counted (the `noClientIp` convention) rather than
  // every such request pooling in one bucket that would throttle all shoppers at once.
  skip: req => noClientIp(req) || skipForLoadTest(req),
  keyGenerator: req => ipKeyGenerator(req.ip ?? ''),
});

// Cart rate limiter - prevent cart bombing
export const cartLimiter = plannedRateLimit('cart', {
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 cart operations per minute
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many cart operations, please slow down.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Fail-OPEN on a Redis store error (deliberate availability-over-strictness
  // tradeoff, adversarial audit P2): express-rate-limit v8 defaults this to
  // false, which rethrew a Redis blip into a 500 on every limited route —
  // Redis became a single point of failure for the whole write surface while
  // the cache layer deliberately fails open. Unlimited-but-up beats down.
  passOnStoreError: true,
  skip: skipForLoadTest,
  keyGenerator: req => {
    // Use session ID if available, otherwise normalized IP (ipKeyGenerator
    // collapses IPv6 to /64 prefix — ERR_ERL_KEY_GEN_IPV6).
    const sessionId = req.headers['x-session-id'] as string;
    return sessionId || ipKeyGenerator(req.ip ?? '') || 'anonymous';
  },
});

// Newsletter signup limiter — stricter than the cart limiter because the
// signup form has no spam mitigations (no captcha, no email confirmation
// loop). 5 attempts per minute per IP+session is generous for a real human
// who fat-fingered their address but cuts off bot enumeration.
export const newsletterLimiter = plannedRateLimit('newsletter', {
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many newsletter requests, please slow down.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Fail-OPEN on a Redis store error (deliberate availability-over-strictness
  // tradeoff, adversarial audit P2): express-rate-limit v8 defaults this to
  // false, which rethrew a Redis blip into a 500 on every limited route —
  // Redis became a single point of failure for the whole write surface while
  // the cache layer deliberately fails open. Unlimited-but-up beats down.
  passOnStoreError: true,
  skip: skipForLoadTest,
  keyGenerator: req => {
    // ipKeyGenerator() collapses IPv6 to /64 prefix — ERR_ERL_KEY_GEN_IPV6.
    const sessionId = req.headers['x-session-id'] as string;
    return `${sessionId || 'anon'}:${ipKeyGenerator(req.ip ?? '') || 'noip'}`;
  },
});

// WhatsApp marketing-consent: per-CALLER ceiling (the signed-in customer), applied to grants AND
// revocations so one customer cannot spam, but keyed on the user so nobody else's traffic can exhaust it.
export const whatsappConsentUserLimiter = withoutLimitPlan(
  rateLimit({
    store: makeRateLimitStore(rateLimitRedisClient, 'wa-consent-user'),
    windowMs: 60 * 1000,
    max: 30,
    message: {
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
    },
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
    skip: skipForLoadTestOrTests,
    keyGenerator: req => `u:${req.user?.userId ?? 'anon'}`,
  }),
  'keyed on req.user (set by authenticate, after the request-level prefetch)'
);

// WhatsApp marketing-consent GRANTS: a per-STORE ceiling, keyed on the RESOLVED store id (set by the
// opt-in chain before this runs), never on a raw client header.
export const whatsappConsentStoreLimiter = withoutLimitPlan(
  rateLimit({
    store: makeRateLimitStore(rateLimitRedisClient, 'wa-consent-store'),
    windowMs: 60 * 1000,
    max: Number(process.env.WA_CONSENT_STORE_RATE_LIMIT_PER_MIN) || 120,
    message: {
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
    },
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: true,
    skip: skipForLoadTestOrTests,
    keyGenerator: (req, res) =>
      `s:${(res.locals.waStoreId as string | undefined) ?? ipKeyGenerator(req.ip ?? '')}`,
  }),
  'keyed on res.locals.waStoreId (set by the handler chain, after the request-level prefetch)'
);

// Coupon validate limiter — public brute-force discovery protection.
// 20 attempts per minute per IP is enough for a legitimate checkout flow
// but prevents rapid enumeration of valid coupon codes.
// ipKeyGenerator() collapses IPv6 /128 → /64 (ERR_ERL_KEY_GEN_IPV6).
export const couponValidateLimiter = plannedRateLimit('coupon-validate', {
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Fail-OPEN on a Redis store error (deliberate availability-over-strictness
  // tradeoff, adversarial audit P2): express-rate-limit v8 defaults this to
  // false, which rethrew a Redis blip into a 500 on every limited route —
  // Redis became a single point of failure for the whole write surface while
  // the cache layer deliberately fails open. Unlimited-but-up beats down.
  passOnStoreError: true,
  skip: skipForLoadTest,
  keyGenerator: req => ipKeyGenerator(req.ip ?? '') || 'noip',
});

// Coupon DISTINCT-code budget — closes the enumeration oracle on every public
// endpoint that evaluates a caller-supplied coupon code (POST /orders/quote,
// POST /orders, and POST /coupons/validate itself). Enumeration needs DISTINCT
// codes, so this counts distinct codes per IP per 60s, not requests: a shopper
// who re-quotes the same applied coupon on every cart change is never limited,
// while probing 21 different codes in a window is. One budget across all three
// endpoints, keyed per IP (ipKeyGenerator collapses IPv6 /128 -> /64).
//
// Built from two counters on the same RedisOrMemoryStore the other limiters use
// (Redis, the Workers AuthState DO, or process memory), because the Workers shim
// has no set commands: an "admitted" marker per (ip, code-hash) written only AFTER
// the code was let through, and a per-IP counter of codes that were not yet admitted.
// Over budget NOTHING is written (no marker to reset), so two concurrent requests for
// the same new code are both refused; under budget such a pair may count twice, which
// only over-counts (conservative). Markers hold the hash only, never the raw code.
const COUPON_DISTINCT_MAX = 20;
const COUPON_DISTINCT_WINDOW_MS = 60 * 1000;
const couponAdmittedStore = makeRateLimitStore(
  rateLimitRedisClient,
  'coupon-validate-distinct-admitted'
);
const couponDistinctStore = makeRateLimitStore(rateLimitRedisClient, 'coupon-validate-distinct');
couponAdmittedStore.init?.({ windowMs: COUPON_DISTINCT_WINDOW_MS } as Options);
couponDistinctStore.init?.({ windowMs: COUPON_DISTINCT_WINDOW_MS } as Options);

function couponDistinctGate(field: 'couponCode' | 'code') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const raw = (req.body as Record<string, unknown> | undefined)?.[field];
    if (typeof raw !== 'string' || raw.trim().length === 0 || skipForLoadTest(req)) {
      next();
      return;
    }
    try {
      const ip = ipKeyGenerator(req.ip ?? '') || 'noip';
      const hash = createHash('sha256').update(raw.trim().toUpperCase()).digest('hex');
      const markerKey = `${ip}:${hash}`;
      if (!(await couponAdmittedStore.get?.(markerKey))) {
        const distinct = await couponDistinctStore.increment(ip);
        if (distinct.totalHits > COUPON_DISTINCT_MAX) {
          res.setHeader('Retry-After', String(COUPON_DISTINCT_WINDOW_MS / 1000));
          res.status(429).json({
            success: false,
            error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
          });
          return;
        }
        await couponAdmittedStore.increment(markerKey);
      }
    } catch (err) {
      // Fail-OPEN on a store error, same posture as passOnStoreError on the other limiters.
      logger.warn({ err }, 'coupon distinct limiter store error; failing open');
    }
    next();
  };
}

/** POST /orders/quote + POST /orders: `couponCode` in the body. */
export const couponAttemptLimiter = couponDistinctGate('couponCode');
/** POST /coupons/validate: `code` in the body. Runs after couponValidateLimiter. */
export const couponValidateDistinctLimiter = couponDistinctGate('code');

// Guest return request limiters (Foundation criterion 19, Ruling GUEST-RET-1). The route takes an order number
// plus a second factor from an anonymous caller, so both axes are bounded: per IP (a scanner walking order
// numbers) and per (store, order number) (one order's phone/email being guessed from many IPs). Every attempt
// counts, success or not: a legitimate shopper files one return. Keyed on a hash, never the raw number.
// `skipForLoadTest` (not `...OrTests`) on purpose: the tests drive the real 429. Fail-OPEN on a store error,
// the posture of the other limiters here.
const GUEST_RETURN_WINDOW_MS = 15 * 60 * 1000;
const GUEST_RETURN_BODY = {
  success: false,
  error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later.' },
};
// pq-allow(unused-export): test seam, imported by apps/api/src/middleware/__tests__/guest-return-limiter.test.ts
export const GUEST_RETURN_IP_MAX = 10;
// pq-allow(unused-export): test seam, imported by apps/api/src/middleware/__tests__/guest-return-limiter.test.ts
export const GUEST_RETURN_ORDER_MAX = 5;
export const guestReturnIpLimiter = rateLimit({
  store: makeRateLimitStore(rateLimitRedisClient, 'guest-return-ip'),
  windowMs: GUEST_RETURN_WINDOW_MS,
  max: GUEST_RETURN_IP_MAX,
  message: GUEST_RETURN_BODY,
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
  skip: skipForLoadTest,
  keyGenerator: req => ipKeyGenerator(req.ip ?? '') || 'noip',
});
function guestReturnOrderKey(req: Request): string {
  const raw = (req.body as Record<string, unknown> | undefined)?.orderNumber;
  const num = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  const store = String((req.params as Record<string, string> | undefined)?.storeId ?? '');
  return createHash('sha256').update(`${store}:${num}`).digest('hex');
}
export const guestReturnOrderLimiter = rateLimit({
  store: makeRateLimitStore(rateLimitRedisClient, 'guest-return-order'),
  windowMs: GUEST_RETURN_WINDOW_MS,
  max: GUEST_RETURN_ORDER_MAX,
  message: GUEST_RETURN_BODY,
  standardHeaders: true,
  legacyHeaders: false,
  passOnStoreError: true,
  skip: skipForLoadTest,
  keyGenerator: guestReturnOrderKey,
});

// Promotion preview limiter — public storefront targeting-preview endpoint.
// Same posture as couponValidateLimiter (20/min per IP): generous for a
// legitimate checkout flow (recomputed on every cart mutation) while
// bounding scrape/enumeration volume against the targeting resolver.
// ipKeyGenerator() collapses IPv6 /128 → /64 (ERR_ERL_KEY_GEN_IPV6).
export const promotionPreviewLimiter = plannedRateLimit('promotion-preview', {
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Fail-OPEN on a Redis store error (deliberate availability-over-strictness
  // tradeoff, adversarial audit P2): express-rate-limit v8 defaults this to
  // false, which rethrew a Redis blip into a 500 on every limited route —
  // Redis became a single point of failure for the whole write surface while
  // the cache layer deliberately fails open. Unlimited-but-up beats down.
  passOnStoreError: true,
  // `skipForLoadTestOrTests`, matching `publicTenantLimiter` below — which
  // wraps this SAME route. With the plain `skipForLoadTest`, an integration
  // suite mounting the real router spent the live 20/min budget from one IP
  // against a Redis store shared across vitest workers and persisting between
  // files. It passed with headroom, but the margin was invisible: four more
  // cases, a second suite on this endpoint, or a same-minute re-run tips it
  // over, and the failure surfaces as `Cannot read properties of undefined
  // (reading 'promotion')` rather than as a 429 — the misleading-artefact
  // failure mode the retry-safety rule exists to prevent.
  skip: skipForLoadTestOrTests,
  keyGenerator: req => ipKeyGenerator(req.ip ?? '') || 'noip',
});

// View ingest limiter — public PDP beacon, high-traffic, unauthenticated.
// 60 requests per minute per IP. The in-memory session debounce in
// view-ingest.service.ts provides a second layer: one DB increment per
// (sessionId, productId) per 10-minute window regardless of IP rotation.
// Key by normalized IP so IPv6 /128 bots can't bypass via address churn
// (ipKeyGenerator collapses to /64 prefix — ERR_ERL_KEY_GEN_IPV6).
export const viewIngestLimiter = plannedRateLimit('view-ingest', {
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 view beacons per minute per IP (generous for real browsing)
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Fail-OPEN on a Redis store error (deliberate availability-over-strictness
  // tradeoff, adversarial audit P2): express-rate-limit v8 defaults this to
  // false, which rethrew a Redis blip into a 500 on every limited route —
  // Redis became a single point of failure for the whole write surface while
  // the cache layer deliberately fails open. Unlimited-but-up beats down.
  passOnStoreError: true,
  skip: skipForLoadTest,
  keyGenerator: req => ipKeyGenerator(req.ip ?? '') || 'noip',
});

// Per-TENANT aggregate limiter for the public surface (adversarial audit
// P3 defense-in-depth): every public limiter above keys on IP (or session),
// so a small IP pool multiplies its allowance and nothing bounds aggregate
// load against ONE store's expensive endpoints (search, resolve, coupon
// validate). This second dimension keys on the tenant headers the storefront
// always sends and caps the aggregate regardless of source-IP spread. The
// cap is deliberately generous (default 6000/min ≈ 100 rps per store —
// far above legitimate flash-sale traffic) because it is a backstop against
// distributed burn, not a per-user fairness limit. Keyed on the RAW header
// (no DB lookup — limiters must stay cheap); requests with no tenant header
// fall back to the normalized IP so they never share one global bucket.
export const publicTenantLimiter = plannedRateLimit('public-tenant', {
  windowMs: 60 * 1000,
  max: Number(process.env.PUBLIC_TENANT_RATE_LIMIT_PER_MIN) || 6000,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Fail-OPEN on a Redis store error — same posture as every limiter above.
  passOnStoreError: true,
  skip: skipForLoadTestOrTests,
  keyGenerator: publicTenantKey,
});

// ==========================================
// Audit Logging
// ==========================================

export interface AuditLogEntry {
  action: string;
  userId?: string;
  resourceType: string;
  resourceId?: string;
  /**
   * Free-form JSON metadata. Accepts nested objects so callers can record
   * structured transitions like `{ role: { from: 'store_admin', to: 'super_admin' } }`.
   * The audit_logs table column is JSONB so anything serialisable fits.
   */
  details?: Record<string, unknown>;
  /**
   * Optional store scope — denormalised so per-store audit queries don't
   * need to join through resource → store. NULL for platform-wide events.
   */
  storeId?: string;
  ip?: string;
  userAgent?: string;
  /**
   * The super_admin acting through an impersonation session. Normally NOT passed: `auditLog` fills it from the request's
   * impersonation scope (lib/impersonation-context.ts) and stores it in `details.impersonatedBy` (BE:S-2).
   */
  impersonatedBy?: string;
}

function withImpersonator(entry: AuditLogEntry): Record<string, unknown> {
  const details: Record<string, unknown> = entry.details
    ? JSON.parse(JSON.stringify(entry.details))
    : {};
  const by = entry.impersonatedBy ?? currentImpersonator();
  if (by && details.impersonatedBy === undefined) details.impersonatedBy = by;
  return details;
}

/**
 * The audit write that REPORTS failure. `auditLog` below swallows by design (a missing trail must not fail a
 * request); a money path cannot accept that, because a swallowed failure is invisible: no alert, no retry. The
 * refund route writes its intent row with this BEFORE money moves and refuses when it throws (M-128).
 */
export async function auditLogStrict(entry: AuditLogEntry): Promise<void> {
  // Log to structured logger in development
  if (process.env.NODE_ENV !== 'production') {
    logger.info({ audit: entry }, '[AUDIT]');
  }
  // Store in database. Savepointed (issue 2215's class): route handlers call this inside the request's single
  // tenant transaction, and an unguarded failure aborted that transaction.
  //
  // Through the append-only definer `ebda_audit_log_insert` (lib/definer.ts): `audit_logs` is store-scoped under
  // strict RLS, but platform events carry no store, and a request may log against a store other than its own.
  await withSavepoint(() =>
    insertAuditLog({
      action: entry.action,
      userId: entry.userId,
      storeId: entry.storeId,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      details: withImpersonator(entry),
      ip: entry.ip,
      userAgent: entry.userAgent,
    })
  );
}

export async function auditLog(entry: AuditLogEntry) {
  try {
    await auditLogStrict(entry);
  } catch (error) {
    // Don't fail the request if audit logging fails
    logger.error({ err: error }, '[AUDIT ERROR] Failed to write audit log');
  }
}

// ==========================================
// Input Sanitization
// ==========================================

/** A sanitised copy of a request body, exactly as `sanitizeInput` rewrites it (PERF-BATCH-1: key prediction before it runs). */
export function sanitizedBody(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  return Array.isArray(body)
    ? sanitizeArray(body)
    : sanitizeObject(body as Record<string, unknown>);
}

export function sanitizeInput(req: Request, _res: Response, next: NextFunction) {
  // Recursively sanitize strings in body. A top-level ARRAY body (a JSON-RPC batch on the MCP
  // route) stays an array: through sanitizeObject it became {"0":...} and the route's
  // Array.isArray(req.body) batch check could never be true.
  if (req.body && typeof req.body === 'object') {
    req.body = Array.isArray(req.body) ? sanitizeArray(req.body) : sanitizeObject(req.body);
  }

  // Sanitize query params
  if (req.query && typeof req.query === 'object') {
    req.query = sanitizeObject(req.query) as typeof req.query;
  }

  next();
}

// Maximum allowed length for any single input string before it is truncated.
const MAX_INPUT_STRING_LENGTH = 10_000;

// Fields that legitimately carry large payloads (bulk-import CSV text and
// base64-encoded XLSX uploads). These are exempt from the per-string length
// truncation \u2014 silently slicing them to 10k chars corrupts an import to ~21
// rows. They still get control-char / invisible-unicode stripping (which also
// protects the Postgres TEXT column from NUL bytes) and their own size limits
// come from express.json's 10mb body cap + route-level validation.
const LARGE_CONTENT_KEYS = new Set(['csvData', 'xlsxBase64']);

function sanitizeString(str: string, enforceMaxLength = true): string {
  // Strip null bytes and non-printable control characters (preserve newline \n, tab \t, carriage return \r)
  let cleaned = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Remove zero-width and invisible unicode characters that can be used to bypass filters
  cleaned = cleaned.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF\uFFF9-\uFFFB]/g, '');

  // Enforce maximum length to prevent excessively large payloads slipping through body parsers
  if (enforceMaxLength && cleaned.length > MAX_INPUT_STRING_LENGTH) {
    cleaned = cleaned.slice(0, MAX_INPUT_STRING_LENGTH);
  }

  // NOTE: HTML encoding is intentionally NOT done here. Encoding at storage time corrupts
  // URLs, descriptions, and causes double-encoding issues. Output escaping must happen at
  // render time (template layer / invoice generation), not at input time.

  return cleaned.trim();
}

/**
 * Arrays keep their shape at every depth, including a top-level array body. An array that went
 * through `sanitizeObject` was rebuilt as an object (`["S","52"]` -> `{"0":"S","1":"52"}`): a
 * size chart's `rows` (B0 Task 9) and an MCP JSON-RPC batch both reached their routes as objects.
 */
function sanitizeArray(arr: unknown[]): unknown[] {
  return arr.map(item =>
    Array.isArray(item)
      ? sanitizeArray(item)
      : typeof item === 'object' && item !== null
        ? sanitizeObject(item as Record<string, unknown>)
        : typeof item === 'string'
          ? sanitizeString(item)
          : item
  );
}

/**
 * Keys never copied out of a request, at any depth. `sanitized['__proto__'] = value` on a plain
 * object REPLACES its prototype (prototype pollution of the result), and `constructor` /
 * `prototype` are the other two pollution vectors. No request field uses these names.
 */
const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (POLLUTION_KEYS.has(key)) continue;
    if (typeof value === 'string') {
      sanitized[key] = sanitizeString(value, !LARGE_CONTENT_KEYS.has(key));
    } else if (Array.isArray(value)) {
      sanitized[key] = sanitizeArray(value);
    } else if (value && typeof value === 'object') {
      sanitized[key] = sanitizeObject(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

// ==========================================
// Security Headers Enhancement
// ==========================================

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  // HSTS - Strict Transport Security (1 year, include subdomains, preload ready)
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  // Additional security headers beyond helmet
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // X-XSS-Protection is deprecated and harmful in modern browsers
  // (Chrome's XSS auditor caused side-channel info leaks before being
  // removed in Chrome 78). MDN recommends explicitly disabling it
  // rather than enabling — `0` tells legacy browsers not to engage
  // the auditor either. Modern XSS defense is CSP (set below) plus
  // the HTML escaping in transactional emails.
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Permissions-Policy: lock down every feature the API has no business
  // exposing. Was previously a 4-feature subset which left the door
  // open for accelerometer / fullscreen / autoplay etc. to be granted
  // to the platform origin if a future error page rendered HTML. The
  // exhaustive list is harder to drift on review; if a future feature
  // legitimately needs one, drop it from this list explicitly.
  res.setHeader(
    'Permissions-Policy',
    [
      'accelerometer=()',
      'ambient-light-sensor=()',
      'autoplay=()',
      'battery=()',
      'camera=()',
      'cross-origin-isolated=()',
      'display-capture=()',
      'document-domain=()',
      'encrypted-media=()',
      'execution-while-not-rendered=()',
      'execution-while-out-of-viewport=()',
      'fullscreen=()',
      'geolocation=()',
      'gyroscope=()',
      'keyboard-map=()',
      'magnetometer=()',
      'microphone=()',
      'midi=()',
      'navigation-override=()',
      'payment=()',
      'picture-in-picture=()',
      'publickey-credentials-get=()',
      'screen-wake-lock=()',
      'sync-xhr=()',
      'usb=()',
      'web-share=()',
      'xr-spatial-tracking=()',
    ].join(', ')
  );

  // Content Security Policy — API serves JSON, not HTML, so this is a
  // defense-in-depth measure in case an error page or redirect is rendered.
  res.setHeader(
    'Content-Security-Policy',
    ["default-src 'none'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"].join(
      '; '
    )
  );

  // Remove server identification
  res.removeHeader('X-Powered-By');
  res.removeHeader('Server');

  // Prevent MIME type sniffing
  res.setHeader('X-Download-Options', 'noopen');

  // Cross-Origin policies
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  next();
}

// ==========================================
// Request ID for tracing
// ==========================================

export function requestId(req: Request, res: Response, next: NextFunction) {
  const clientId = req.headers['x-request-id'] as string;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const id = clientId && uuidRegex.test(clientId) ? clientId : randomUUID();
  req.headers['x-request-id'] = id;
  res.setHeader('X-Request-Id', id);
  next();
}
