import type { Request, RequestHandler, Response } from 'express';
import { resolvedStoreId } from '../utils/resolved-store';

/**
 * LAUNCH-RL-MISS-3: the one kind of 404 the store-miss limiter (`storeMissLimiter`, middleware/security.ts) does not count.
 *
 * Every 404 of the public router is a counted miss by default. A dead product or blog link inside a store that EXISTS is
 * not store probing (the slugs are public in the sitemap), and counting it let ordinary browsing, or the storefront's own
 * server render, spend the 20 per minute per IP budget and get the whole public router refused. Such a 404 is exempt only
 * when all three hold; anything else stays counted with no marker needed:
 *
 *  1. flag: the resolver verified a store for this request (`resolvedStoreId`, set only by `resolvePublicStoreId` after
 *     the active-store lookup by `X-Store-ID` or host; never a well-formed id read from the path);
 *  2. list: the route that answered carries `catalogueMissRoute(...)` and its name is on `CATALOGUE_MISS_ROUTES`;
 *  3. same store: the route's own store id (the path `:storeId` when the route has one, else the resolved id) is the id
 *     the resolver verified.
 *
 * Each condition has its own defence mutation (docs/security/defence-mutations.json, `store-miss-exempt-*`).
 * Adding a route here needs a ruling: its 404 must say nothing that is not already public.
 */
export const CATALOGUE_MISS_ROUTES = [
  'GET /public/products/:slugOrId',
  'GET /public/:storeId/blog/:slug',
] as const;
export type CatalogueMissRoute = (typeof CATALOGUE_MISS_ROUTES)[number];

const LISTED: ReadonlySet<string> = new Set(CATALOGUE_MISS_ROUTES);
type Mark = { route: string; pathStoreId?: string };
/** Keyed by the response object itself: no property is ever written onto it, so no request-controlled key can reach one. */
const MARKS = new WeakMap<Response, Mark>();

/** Route middleware for the routes on `CATALOGUE_MISS_ROUTES`, in front of the handler. It reads the path id at the route. */
export function catalogueMissRoute(route: CatalogueMissRoute): RequestHandler {
  return (req, res, next) => {
    MARKS.set(res, { route, pathStoreId: req.params.storeId });
    next();
  };
}

/** True only for a 404 the store-miss limiter may leave uncounted. The caller has already checked the status. */
export function isVerifiedCatalogueMiss(req: Request, res: Response): boolean {
  const verified = resolvedStoreId(req);
  const mark = MARKS.get(res);
  const flagged = Boolean(verified);
  const listed = mark !== undefined && LISTED.has(mark.route);
  const sameStore = (mark?.pathStoreId ?? verified) === verified;
  return flagged && listed && sameStore;
}
