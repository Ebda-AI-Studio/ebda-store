import type { Request } from 'express';
import { config } from '../config';
import { BoundedMap } from './bounded-map';
import { isPlatformOrigin } from './cors-cache';
import { resolveStoreId } from './definer';
import { storeLookupForHost } from './store-host';
import { resolvePublicStoreId } from '../utils/store-helpers';

/**
 * Customer identity is bound to ONE store (S11 / F-01, docs/security/audit-2026-10-14.md).
 *
 * The auth cookie is SameSite=None on the API host and CORS is credentialed for every
 * live store origin, so a page on store B's verified domain can make a signed-in
 * customer of store A's browser send A's cookie. Two facts together close that:
 *
 *   1. The customer token carries the store it was issued for (`storeId`, stamped by
 *      `AuthService.generateTokens` from `users.store_id`).
 *   2. The request's ORIGIN, which a page cannot forge, must belong to that same store.
 *
 * Checking the token against the caller-sent `X-Store-ID` alone is NOT enough: the
 * attacker simply sends A's id. The Origin check is what binds the request to the page
 * that made it. It runs in ONE place — `authenticate` / `optionalAuthenticate` call
 * {@link customerTokenMatchesRequestStore} for every customer token — so no customer
 * route can forget it.
 *
 * Rules (all must hold):
 *   - token.storeId is a non-empty string (older tokens without it fail: they re-mint
 *     through the silent refresh, which stamps it);
 *   - a store ORIGIN (`<slug>.ebda.app` or a verified custom domain; anything that is
 *     not a platform origin) resolves to token.storeId, else false — also when the
 *     origin resolves to no active store;
 *   - the store named by `X-Store-ID` / `x-store-domain`, when present, equals
 *     token.storeId;
 *   - with no store origin (platform origins: localhost, previews; or no Origin at all,
 *     which is not a browser cross-site call) the token's own storeId is the binding.
 */

/** host -> store id for an Origin. Bounded-stale (120s): a domain moving between stores
 *  is the only thing this can lag on; the answer is never used to GRANT beyond the token. */
const ORIGIN_STORE_TTL_MS = 120_000;
const originStoreCache = new BoundedMap<string, { storeId: string | null; expiresAt: number }>(
  2000
);

async function storeIdForOrigin(origin: string): Promise<string | null> {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return null;
  }
  const lookup = storeLookupForHost(host);
  if (!lookup) return null;
  const now = Date.now();
  const hit = originStoreCache.get(lookup.cacheHost);
  if (hit && hit.expiresAt > now) return hit.storeId;
  const storeId = await resolveStoreId(
    lookup.by === 'slug' ? { slug: lookup.slug } : { domain: lookup.domain }
  );
  originStoreCache.set(lookup.cacheHost, { storeId, expiresAt: now + ORIGIN_STORE_TTL_MS });
  return storeId;
}

/** Test seam: drop the origin cache. */
export function clearOriginStoreCache(): void {
  originStoreCache.clear();
}

/**
 * True when the request was made by a browser page on a STORE origin: a `<slug>.ebda.app`
 * host, a merchant custom domain, an unknown host or `Origin: null` — anything that sent an
 * Origin and is not a platform origin. Such a page is merchant-controlled (any merchant can
 * verify a domain they own), so it is never trusted with an identity beyond the origin
 * store's own customer. See {@link nonCustomerTokenAllowedForRequest}.
 */
export function isStoreOriginRequest(req: Request): boolean {
  const origin = req.headers.origin as string | undefined;
  return (
    !!origin &&
    !isPlatformOrigin(origin, {
      webUrl: config.webUrl,
      adminUrl: config.adminUrl,
      nodeEnv: config.nodeEnv,
    })
  );
}

/**
 * Issue #622 / Ruling CORS-TB-1: credentialed cross-origin = same-tenant only.
 *
 * The `token` cookie on the API host carries EVERY kind of session: a shopper's store-bound
 * customer token, and — set by `POST /auth/session` from the admin app — a merchant's,
 * staff member's or platform admin's identity token (plus HS256 impersonation tokens). The
 * cookie is SameSite=None and CORS is credentialed for every verified merchant domain, so a
 * page on merchant A's domain makes a lured store-B owner's (or a super_admin's) browser
 * send that cookie. The customer case is closed by {@link customerTokenMatchesRequestStore};
 * this closes the rest: from a store origin, a non-customer token is NO identity at all.
 *
 * This is an allow-list on the PRINCIPAL, not on paths. `restrictPlatformOnlyOrigins` denies
 * the /admin, /payment-settings and /stores prefixes, but ~20 other credentialed mounts
 * (/auth/me, /realtime/session, /uploads, /onboarding, /mcp/admin, /provider-activation, …)
 * were reachable with a merchant identity from any merchant origin. Enumerating paths goes
 * stale with every new router; refusing the identity cannot. The storefront never needs a
 * non-customer identity (apps/web AuthContext already rejects any role but `customer`).
 */
export function nonCustomerTokenAllowedForRequest(req: Request): boolean {
  return !isStoreOriginRequest(req);
}

export async function customerTokenMatchesRequestStore(
  req: Request,
  tokenStoreId: unknown
): Promise<boolean> {
  if (typeof tokenStoreId !== 'string' || tokenStoreId.length === 0) return false;

  const origin = req.headers.origin as string | undefined;
  const headerStore = await resolvePublicStoreId(req);
  if (headerStore !== undefined && headerStore !== tokenStoreId) return false;

  if (origin && isStoreOriginRequest(req)) {
    return (await storeIdForOrigin(origin)) === tokenStoreId;
  }
  return true;
}
