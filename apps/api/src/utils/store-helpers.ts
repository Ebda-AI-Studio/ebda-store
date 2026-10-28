import { Request } from 'express';
import { setResolvedStoreId } from './resolved-store';
import { AppError } from '../middleware/error-handler';
import { AuthPayload } from '../middleware/auth';
import { storeLookupForHost } from '../lib/store-host';
import { lookupStore, resolveStoreId } from '../lib/definer';
import { captureEdgeSnapshot } from '../lib/edge-gens';

/**
 * Extracts the authenticated user from the request.
 * Use in routes that run after the `authenticate` middleware —
 * this replaces the `req.user!` non-null assertion with a proper runtime check.
 */
export function getAuthUser(req: Request): AuthPayload {
  if (!req.user) {
    throw new AppError(401, 'UNAUTHORIZED', 'Not authenticated');
  }
  return req.user;
}

/**
 * Resolve a store ID from the X-Store-ID / x-store-domain headers, validated
 * against the DB (must be an active store). Returns `undefined` rather than
 * throwing — the shared, non-throwing half that both `getStoreIdFromRequest`
 * (below) and `requireFeature` (middleware/feature-gate.ts) build on.
 *
 * Before this was shared, `requireFeature` had its OWN inline resolution —
 * `req.headers['x-store-id']` read raw, with no DB check and no
 * x-store-domain fallback — on routes with no `:storeId`/`:id` route param
 * (e.g. POST /public/cart/bundles). That let the feature gate and the
 * handler it guards resolve to two DIFFERENT stores for the same request: a
 * client sending only `x-store-domain` (no `x-store-id`) got FEATURE_DISABLED
 * from the gate even when the domain-resolved store had the feature on,
 * because the gate could not see the domain header at all.
 */
const RESOLVED_PUBLIC_STORE = Symbol('ebda.resolvedPublicStore');

export async function resolvePublicStoreId(req: Request): Promise<string | undefined> {
  // Resolved at most once per request: the public-route store scope
  // (`publicStoreContext`) resolves it first and every handler's own
  // `getStoreIdFromRequest` then reuses the answer.
  const memo = (req as unknown as Record<symbol, Promise<string | undefined>>)[
    RESOLVED_PUBLIC_STORE
  ];
  if (memo) return memo;
  const pending = lookupPublicStoreId(req).then(async id => {
    if (id) {
      setResolvedStoreId(req, id);
      // Edge-cache fill (SEO-3): stamp the cache generations before any data read, so a write that lands
      // while this request reads can only make the stored copy invalid, never wrongly valid.
      await captureEdgeSnapshot(req, id);
    }
    return id;
  });
  (req as unknown as Record<symbol, Promise<string | undefined>>)[RESOLVED_PUBLIC_STORE] = pending;
  return pending;
}

async function lookupPublicStoreId(req: Request): Promise<string | undefined> {
  const headerStoreId = req.headers['x-store-id'] as string | undefined;
  if (headerStoreId) {
    // `stores` is under RLS (R-EBDA-005): an ACTIVE, not-deleted store with this id,
    // through the lookup definer (id only).
    const store = await lookupStore({ id: headerStoreId }, ['active']);
    if (store) return store.id;
  }

  const lookup = storeLookupForHost(req.headers['x-store-domain'] as string | undefined);
  if (lookup) {
    // The host -> store lookup is a SECURITY DEFINER function
    // (`ebda_resolve_store_id`): exact slug / custom-domain match on an active
    // store, id only — the same call the Worker shell makes first.
    const storeId = await resolveStoreId(
      lookup.by === 'slug' ? { slug: lookup.slug } : { domain: lookup.domain }
    );
    if (storeId) return storeId;
  }

  return undefined;
}

export async function getStoreIdFromRequest(req: Request): Promise<string> {
  const storeId = await resolvePublicStoreId(req);
  if (storeId) return storeId;

  throw new AppError(
    400,
    'STORE_NOT_RESOLVED',
    'Unable to resolve store context. Provide X-Store-ID or x-store-domain header.'
  );
}
