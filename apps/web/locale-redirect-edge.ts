/**
 * Ruling LOCALE-REDIRECT-EDGE-1: an old UNPREFIXED storefront URL (`/`, `/products/x`) of a store with language-in-the-URL
 * ON is redirected by the Worker, before Next renders anything.
 *
 * WHY: the middleware has no store, so it marked the request "pending" and the ROOT LAYOUT redirected it with
 * `permanentRedirect()` once it had the store's default language. A redirect thrown inside a render comes back as the
 * full Next error shell (an 82 KB `<html id="__next_error__">` body with the 308, measured on storedemo-lamma.ebda.app/
 * 2026-11-09), costs a whole layout render (store fetch, metadata, viewport) for a response that is only a Location, and
 * when anything in that render failed first the visitor got a 500 instead of the redirect (lamma/dahab, same day).
 * Here it is an empty-body 308/307 decided from the same rules (`decideLocalePath` + `pendingRedirect`, locale-paths.ts)
 * and the store's default language from the API resolver (`storeVerdict`, the call the edge cache already makes,
 * remembered 60 s per isolate).
 *
 * Falls through to Next (the old path, unchanged) whenever it cannot decide: not GET/HEAD, locale paths off for the
 * store, the admin preview iframe (`?_preview=`), a path that is not pending, or a store the resolver does not vouch for
 * (unknown, inactive, resolver down). CACHE CLASS of the default language: BOUNDED-stale, <= 60 s per isolate after a
 * merchant changes it (the layout path read it through the Next data cache with the same window).
 *
 * Ruling ICEBERG-EDGE-308-1 (2026-11-10, Iceberg audit #18): the PERMANENT 308 to the store's default language is
 * `private, max-age=300` + `Vary: Cookie`, so a returning visitor's browser skips the round trip (measured 2026-11-10:
 * the 308 itself costs 0.65-2.2 s ttfb, a Worker isolate + resolver hop). `private` keeps it out of every shared/edge
 * cache; `Vary: Cookie` re-asks once the visitor's `force-language` cookie changes. The cookie-driven 307 stays
 * `private, no-store`. Staleness: BOUNDED, <= 300 s in one browser (+ the 60 s isolate) after a merchant changes the
 * default language.
 */
import {
  decideLocalePath,
  localePathsOn,
  pendingRedirect,
  storeKeyForHost,
} from './src/lib/locale-paths';

/** The subset of the Workers Cache API used here (structurally the same as store-edge-cache's CacheLike). */
export interface RedirectCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, res: Response): Promise<void>;
}

/** Ruling WEB-COLD-4: how long a cached cookie-less 308 may be served. Same window as the per-isolate verdict memo. */
export const REDIRECT_CACHE_TTL_S = 60;

export type DefaultLanguageOf = (host: string) => Promise<'ar' | 'en' | null>;

export async function edgeLocaleRedirect(
  request: Request,
  env: Record<string, unknown>,
  defaultLanguageOf: DefaultLanguageOf,
  cache?: { store: RedirectCache; waitUntil(p: Promise<unknown>): void }
): Promise<Response | null> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const url = new URL(request.url);
  if (url.searchParams.has('_preview')) return null;
  const strEnv: Record<string, string | undefined> = {
    STOREFRONT_LOCALE_PATHS:
      typeof env.STOREFRONT_LOCALE_PATHS === 'string' ? env.STOREFRONT_LOCALE_PATHS : undefined,
    STOREFRONT_LOCALE_PATHS_STORES:
      typeof env.STOREFRONT_LOCALE_PATHS_STORES === 'string'
        ? env.STOREFRONT_LOCALE_PATHS_STORES
        : undefined,
  };
  if (!localePathsOn(storeKeyForHost(url.hostname), strEnv)) return null;
  const decision = decideLocalePath({
    pathname: url.pathname,
    search: url.search,
    method: request.method,
  });
  if (decision.kind !== 'pending') return null;
  const hasCookie = /(?:^|;\s*)force-language=(ar|en)(?:;|$)/.test(
    request.headers.get('cookie') ?? ''
  );
  // Ruling WEB-COLD-4: the cookie-less 308 depends only on host + path, so it is remembered across isolates and data centres'
  // Cache API colo (a cold isolate then skips the resolver subrequest). Cookie visitors never touch it (their target differs).
  const cacheKey = `https://${url.hostname}/__edge-locale-redirect${url.pathname}${url.search}`;
  if (cache && !hasCookie) {
    try {
      const hit = await cache.store.match(cacheKey);
      const loc = hit?.headers.get('x-redirect-location');
      if (loc && loc.startsWith('/') && !loc.startsWith('//')) {
        return new Response(null, { status: 308, headers: permanentHeaders(loc) });
      }
    } catch {
      // cache unavailable: decide live
    }
  }
  let defaultLocale: 'ar' | 'en' | null = null;
  try {
    defaultLocale = await defaultLanguageOf(url.hostname);
  } catch {
    return null;
  }
  if (!defaultLocale) return null;
  const cookieLocale = /(?:^|;\s*)force-language=(ar|en)(?:;|$)/.exec(
    request.headers.get('cookie') ?? ''
  )?.[1];
  const target = pendingRedirect({
    rest: decision.rest,
    search: url.search,
    defaultLocale,
    cookieLocale,
  });
  // Same-origin path only (the rules already produce one; refuse anything else rather than redirect off-site).
  if (!target.location.startsWith('/') || target.location.startsWith('//')) return null;
  if (cache && !hasCookie && target.permanent) {
    cache.waitUntil(
      cache.store
        .put(
          cacheKey,
          new Response(null, {
            status: 200,
            headers: {
              'x-redirect-location': target.location,
              'cache-control': `public, max-age=${REDIRECT_CACHE_TTL_S}`,
            },
          })
        )
        .catch(() => {})
    );
  }
  return new Response(null, {
    status: target.permanent ? 308 : 307,
    headers: target.permanent
      ? permanentHeaders(target.location)
      : { location: target.location, 'cache-control': 'private, no-store' },
  });
}

function permanentHeaders(location: string): Record<string, string> {
  return { location, 'cache-control': 'private, max-age=300', vary: 'Cookie' };
}
