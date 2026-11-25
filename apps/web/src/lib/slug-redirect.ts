import { API_URL } from './api';
import { storeAbsoluteUrl } from './structured-data';
import type { ResolvedStore } from './store-resolver';
import { headers } from 'next/headers';
import { LOCALE_PATH_HEADER, localizeHref } from './locale-paths';

/**
 * Resolve a renamed storefront slug (product/category/page/blog) to its
 * current slug via the API's `public/redirects/resolve` endpoint, so the
 * storefront can 308-redirect instead of soft-404ing on a stale handle.
 *
 * Returns `null` (no redirect) on a genuine miss (the API answers
 * `200 { toSlug: null }`; an API older than that answered 404), any non-2xx
 * response, or a network/parse error — callers fall through to their own
 * `notFound()`.
 * The demo store (`store.id === 'demo'`) never has redirect rows, so it
 * short-circuits without a network call.
 */
export async function fetchSlugRedirect(
  store: { id: string; domain?: string },
  type: 'product' | 'category' | 'page' | 'blog',
  slug: string
): Promise<string | null> {
  if (!store.id || store.id === 'demo') return null;
  try {
    const res = await fetch(
      `${API_URL}/public/redirects/resolve?type=${type}&slug=${encodeURIComponent(slug)}`,
      {
        // Cached 60s like the sibling product fetch (#904), keyed per store via
        // the headers. Staleness class: BOUNDED. A miss is a 200 too, so it is
        // cached here as well as API-side (resolveSlugRedirectCached, 60s per
        // instance): after a rename the old link can keep its 404 for up to
        // about 120s before it starts redirecting. Nothing but a stale link
        // depends on this read.
        next: { revalidate: 60 },
        headers: {
          'X-Store-ID': store.id,
          ...(store.domain ? { 'x-store-domain': store.domain } : {}),
        },
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.toSlug === 'string' ? data.toSlug : null;
  } catch {
    return null;
  }
}

/**
 * Absolute in-store URL that preserves the platform `/<slug>` path prefix.
 * Thin wrapper over the general-purpose `storeAbsoluteUrl` (structured-data.ts)
 * — kept as a named export so redirect call sites read intent-first. See
 * `storeAbsoluteUrl`'s doc comment for the full prefix rationale.
 */
export function storeRedirectUrl(store: ResolvedStore, path: string): string {
  return storeAbsoluteUrl(store, path);
}

/**
 * The 308 target of a renamed slug, KEEPING the language prefix of the request (Ruling LOCALE-PATHS-4: a redirect never strips a
 * prefix). `/ar/products/<old>` goes to `/ar/products/<new>`, not to `/products/<new>` (live: ameliaaurum.com dropped `/ar`).
 * The middleware asserts the page's language in `x-locale-path` on a prefixed page; on any other page the path is unchanged.
 * `path` is the unprefixed in-store path, query string included (`/products?category=<new>`).
 */
export async function localizedRedirectUrl(store: ResolvedStore, path: string): Promise<string> {
  let lang: 'ar' | 'en' | null = null;
  try {
    const v = (await headers()).get(LOCALE_PATH_HEADER);
    lang = v === 'ar' || v === 'en' ? v : null;
  } catch {
    // no request context (a build-time render): no prefix to keep
  }
  return storeRedirectUrl(store, localizeHref(path, lang));
}
