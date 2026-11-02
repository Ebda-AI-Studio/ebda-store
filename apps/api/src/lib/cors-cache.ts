// Shared CORS domain cache — extracted to avoid circular imports between
// index.ts (which sets up CORS) and store.routes.ts (which needs to bust the cache).
import { BoundedMap } from './bounded-map';
import { BRAND, brandUrl } from '@ebda/shared';
import { storeDomainWhere, storeLookupForHost } from './store-host';

// Capped so a pathological stream of unknown domains (e.g. bot traffic
// probing random hostnames) can never grow the Map without limit.
//
// `unknown: true` marks a NEGATIVE result from a failed lookup (Neon down /
// pool starved) — distinct from `allowed: false` (a real, resolved
// non-match). Without it, a failed DB lookup populated nothing, so every
// subsequent request for that hostname re-issued the same `prisma.store.
// findFirst` against the already-degraded database for the full outage —
// this cache exists specifically to avoid that hammering. `unknown` entries
// use a much shorter TTL (`CORS_LOOKUP_FAILURE_TTL_MS`) than a resolved one,
// so the outage self-heals within seconds of Neon recovering instead of
// waiting out the full 2-minute TTL.
//
// issue 2109 / issue 2169 — a failed lookup must not turn ONE transient blip
// into a 5-second 503 for every request from a merchant hostname (including
// checkout). So a failure entry also carries:
//   - `failures`: consecutive failed lookups. The FIRST failure still lets the
//     next request re-query (one blip costs one request); only from the
//     second consecutive failure does the entry short-circuit to
//     'unavailable' for the failure TTL (a real outage still collapses to one
//     query per 5s per hostname).
//   - `lastKnownAllowed` / `lastResolvedAt`: the last RESOLVED answer, which
//     used to be overwritten and lost. While lookups are failing, a hostname
//     that was verified within `CORS_STALE_SERVE_MAX_MS` keeps its last answer
//     (stale-allow / stale-reject) instead of going dark; only a hostname
//     that was never resolved (or resolved too long ago) answers 503.
//     `bustCorsCache` deletes the whole entry, so a domain REMOVED by the
//     merchant is never served stale.
export interface CorsCacheEntry {
  allowed: boolean;
  expiresAt: number;
  unknown?: boolean;
  failures?: number;
  lastKnownAllowed?: boolean;
  lastResolvedAt?: number;
}

/**
 * STALENESS CLASS (Ruling NZ-D9): BOUNDED-stale, residual <= 2 minutes per isolate. `bustCorsCache` clears only the isolate
 * that took the write; another isolate keeps its answer until the TTL. Accepted because this cache only decides whether a
 * browser may read a cross-origin response: it grants no access, and every write (cart, checkout, order, payment, account,
 * admin) re-checks store status authoritatively. Cost if wrong: a just-suspended or just-removed custom domain is still
 * allowed to make credentialed cross-origin READS for <= 2 minutes.
 */
export const corsDomainCache = new BoundedMap<string, CorsCacheEntry>(5000);
export const CORS_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
export const CORS_LOOKUP_FAILURE_TTL_MS = 5 * 1000; // 5 seconds
/** Consecutive failed lookups before a never-resolved hostname answers 503 without re-querying. */
export const CORS_FAILURES_BEFORE_UNAVAILABLE = 2;
/** How long a last-known answer may be served while lookups keep failing. */
export const CORS_STALE_SERVE_MAX_MS = 15 * 60 * 1000; // 15 minutes

export type CorsCacheDecision = 'allow' | 'reject' | 'unavailable' | 'miss';

function staleAnswer(cached: CorsCacheEntry, now: number): 'allow' | 'reject' | undefined {
  if (cached.lastKnownAllowed === undefined || cached.lastResolvedAt === undefined) {
    return undefined;
  }
  if (now - cached.lastResolvedAt > CORS_STALE_SERVE_MAX_MS) return undefined;
  return cached.lastKnownAllowed ? 'allow' : 'reject';
}

/**
 * Pure decision over a (possibly absent/expired) cache entry — pulled out of
 * the CORS origin-check closure in `index.ts` so it can be unit-tested
 * without booting the Express app. `'unavailable'` is the #1074 case: lookups
 * for this hostname keep failing (DB outage) and there is no recent resolved
 * answer to fall back on, so the caller must answer 503 WITHOUT re-querying.
 */
export function decideCorsCache(
  cached: CorsCacheEntry | undefined,
  now: number
): CorsCacheDecision {
  if (!cached || cached.expiresAt <= now) return 'miss';
  if (cached.unknown) {
    const stale = staleAnswer(cached, now);
    if (stale) return stale;
    if ((cached.failures ?? 1) < CORS_FAILURES_BEFORE_UNAVAILABLE) return 'miss';
    return 'unavailable';
  }
  return cached.allowed ? 'allow' : 'reject';
}

/** Entry written after a SUCCESSFUL lookup. */
export function corsEntryAfterLookup(allowed: boolean, now: number): CorsCacheEntry {
  return {
    allowed,
    expiresAt: now + CORS_CACHE_TTL_MS,
    lastKnownAllowed: allowed,
    lastResolvedAt: now,
  };
}

/**
 * Entry written after a FAILED lookup. `prev` is whatever the map holds for
 * the hostname — possibly EXPIRED (BoundedMap has no TTL awareness), which is
 * exactly the last-known-good answer we must not throw away.
 */
export function corsEntryAfterFailure(
  prev: CorsCacheEntry | undefined,
  now: number
): CorsCacheEntry {
  const failures = prev?.unknown ? (prev.failures ?? 1) + 1 : 1;
  const lastKnownAllowed = prev ? (prev.unknown ? prev.lastKnownAllowed : prev.allowed) : undefined;
  const lastResolvedAt = prev
    ? prev.unknown
      ? prev.lastResolvedAt
      : (prev.lastResolvedAt ?? prev.expiresAt - CORS_CACHE_TTL_MS)
    : undefined;
  return {
    allowed: false,
    unknown: true,
    failures,
    lastKnownAllowed,
    lastResolvedAt,
    expiresAt: now + CORS_LOOKUP_FAILURE_TTL_MS,
  };
}

/**
 * What the request whose OWN lookup just failed should get: the recent
 * last-known answer if there is one, otherwise 503.
 */
export function decideAfterFailedLookup(
  entry: CorsCacheEntry,
  now: number
): 'allow' | 'reject' | 'unavailable' {
  return staleAnswer(entry, now) ?? 'unavailable';
}

/**
 * Prisma `where` for the credentialed-CORS custom-domain lookup (#1214).
 *
 * Mirrors `/public/store/resolve`: only an `active` or `suspended` store that
 * is not soft-deleted keeps its domain as a trusted origin (suspended stores
 * still serve their branded maintenance page). An inactive or deleted store's
 * domain used to stay a `credentials: true` origin indefinitely, so offboarding
 * a merchant never revoked it.
 *
 * This NARROWS the trust, it does not remove it: an active, fully configured
 * merchant domain is still merchant-controlled, which is why the platform-only
 * origin gate and CSRF tokens (middleware/security.ts) are the real boundary.
 * There is also no persisted domain-verification state to filter on — the
 * Store model has no hostname/SSL status column — so "configured" is all this
 * can check.
 */
export function corsCustomDomainWhere(hostname: string) {
  return {
    ...storeDomainWhere(hostname),
    status: { in: ['active', 'suspended'] as ('active' | 'suspended')[] },
    deletedAt: null,
  };
}

/**
 * Prisma `where` for the credentialed-CORS lookup of ANY store origin host
 * (#1214, extended for host routing): `<slug>.ebda.app` is matched by SLUG,
 * anything else by custom DOMAIN, with the same live-store filter as
 * {@link corsCustomDomainWhere}. Returns `null` for a host that can never be a
 * store (reserved label, platform host, IP, localhost, malformed) — the caller
 * rejects the origin without touching the database.
 */
export function corsStoreOriginWhere(rawHost: string) {
  const lookup = storeLookupForHost(rawHost);
  if (!lookup) return null;
  const live = {
    status: { in: ['active', 'suspended'] as ('active' | 'suspended')[] },
    deletedAt: null,
  };
  return {
    cacheKey: lookup.cacheHost,
    where:
      lookup.by === 'slug'
        ? { slug: lookup.slug, ...live }
        : { ...storeDomainWhere(lookup.domain), ...live },
    /**
     * The same predicate as `where`, for the `ebda_store_lookup` definer (`lookupStore`):
     * the app role cannot read `stores` before a scope exists (R-EBDA-005). `where` stays
     * for owner-role callers (tests, scripts).
     */
    match: lookup.by === 'slug' ? { slug: lookup.slug } : { domain: lookup.domain },
    statuses: live.status.in,
  };
}

/**
 * Bust the CORS cache for a domain. Called when a store's domain changes and,
 * via `bustStoreCaches`, whenever a store's status or other storefront-visible
 * state is written. The cache is per-process, so other replicas converge on
 * `CORS_CACHE_TTL_MS` (2 minutes) — bounded staleness.
 */
export function bustCorsCache(domain: string): void {
  const normalized = domain.toLowerCase().replace(/^www\./, '');
  corsDomainCache.delete(normalized);
  corsDomainCache.delete(`www.${normalized}`);
}

/**
 * Platform-origin allowlist — origins WE control end-to-end. Used by:
 *   - the CORS handler (to short-circuit before the DB lookup)
 *   - the CSRF middleware to decide when the JSON-content-type skip
 *     is safe to apply.
 *
 * Custom merchant domains are NOT platform origins. They're allowed by
 * CORS via DB lookup (a merchant configures `mystore.com` and it gets
 * allowlisted), but a malicious merchant who sets `attacker.com` as
 * their store domain would have that origin allowlisted too. CSRF
 * tokens MUST still be required for JSON requests from such origins —
 * they can't be implicitly trusted just because they passed CORS.
 */
export function isPlatformOrigin(
  origin: string | undefined,
  env: { webUrl?: string; adminUrl?: string; nodeEnv: string }
): boolean {
  if (!origin) return false;

  if (env.webUrl && origin === env.webUrl) return true;
  if (env.adminUrl && origin === env.adminUrl) return true;

  // Hardcoded prod fallbacks — kept in sync with the CORS handler in
  // index.ts so a missing/forgotten env var doesn't downgrade trust.
  // Marketing site, merchant dashboard and the Orders PWA (staff
  // order-management app — a distinct origin from admin). Store origins
  // (`<slug>.ebda.app`) and custom domains are validated separately.
  // (The post-launch WhatsApp platform host is NOT listed here.)
  if (origin === brandUrl(BRAND.domains.marketing)) return true;
  if (origin === brandUrl(BRAND.domains.storeApp)) return true;
  if (origin === brandUrl(BRAND.domains.orders)) return true;

  // Cloudflare Workers preview deploys for the project (OpenNext migration).
  // SCOPED to OUR account subdomain (CF_WORKERS_DEV_SUBDOMAIN) + our worker
  // names — NOT any *.workers.dev, which (with credentials: true) would let an
  // attacker's worker make credentialed requests to the API. Unset = no preview
  // origin is trusted.
  const workersDevSubdomain = process.env.CF_WORKERS_DEV_SUBDOMAIN;
  if (
    workersDevSubdomain &&
    /^[a-z0-9-]+$/.test(workersDevSubdomain) &&
    new RegExp(`^https://ebda-(web|admin|orders)\\.${workersDevSubdomain}\\.workers\\.dev$`).test(
      origin
    )
  ) {
    return true;
  }

  // Localhost in dev.
  if (env.nodeEnv !== 'production' && origin.includes('localhost')) return true;

  return false;
}

/**
 * REMOVED 2026-09-02: `isAllowlistedMerchantOrigin`.
 *
 * It existed to let the CSRF middleware skip its token check for merchant
 * custom domains. That made every DB-registered custom domain CSRF-exempt,
 * and Cloudflare's addDomain creates a custom hostname with NO ownership
 * proof — so any merchant could register a host they control, lure a
 * logged-in super_admin to it and, because the auth cookie is SameSite=None
 * and CORS runs credentials:true, issue credentialed writes AND read the
 * responses, including a full impersonation token from POST /admin/impersonate.
 *
 * Its doc comment argued the residual threat "requires the merchant to
 * compromise their own customers via their own configured domain — outside
 * the threat model". That reasoning only considered the merchant's OWN
 * customers. It never considered another tenant's admin, or a super_admin,
 * being lured to that same domain.
 *
 * Do not reintroduce it. Guest checkout does not need it: `/public/` paths
 * return early from csrfProtection long before the origin check, and the
 * storefront client sends X-Session-ID plus X-CSRF-Token on every
 * state-changing request. Trust for the admin surface is enforced by
 * `restrictPlatformOnlyOrigins` in middleware/security.ts, which is an
 * allowlist of platform origins — not a denylist of bad ones.
 */
