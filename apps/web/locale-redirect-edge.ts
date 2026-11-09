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
 * merchant changes it (the layout path read it through the Next data cache with the same window); the redirect itself is
 * `private, no-store`, so no browser or proxy keeps it.
 */
import {
  decideLocalePath,
  localePathsOn,
  pendingRedirect,
  storeKeyForHost,
} from './src/lib/locale-paths';

export type DefaultLanguageOf = (host: string) => Promise<'ar' | 'en' | null>;

export async function edgeLocaleRedirect(
  request: Request,
  env: Record<string, unknown>,
  defaultLanguageOf: DefaultLanguageOf
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
  return new Response(null, {
    status: target.permanent ? 308 : 307,
    headers: { location: target.location, 'cache-control': 'private, no-store' },
  });
}
