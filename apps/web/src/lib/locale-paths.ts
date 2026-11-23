/**
 * Storefront language in the URL (Ruling LOCALE-PATHS-1, audit M-168): a store that opted in serves its public,
 * indexable pages at `/ar/...` and `/en/...`; the old unprefixed URLs answer a 301 to them. Pure functions, no
 * `next/*` imports: `middleware.ts` (a relative import), the sitemap and the metadata helpers all use the same rules.
 *
 * Scope (Ruling LOCALE-PATHS-4): EVERY storefront page is served under both prefixes. The indexable routes
 * (`LOCALE_PATH_ROOTS` plus the home) are the canonical ones: their unprefixed form is redirected to the prefix. The
 * transactional routes (`LOCALE_SERVED_ROOTS`: cart, checkout, account, auth, search, wishlist, compare, ...) are
 * rewritten under the prefix too and their unprefixed form is NOT redirected (noindex, nothing to canonicalise). A prefix is
 * never stripped by a redirect. Only the API and the file routes (robots, sitemap, llms.txt, favicon...) have no prefix.
 * The URL wins on a prefixed page, and the middleware writes the `force-language` cookie to match.
 *
 * Gate: `STOREFRONT_LOCALE_PATHS=true` AND the store named in `STOREFRONT_LOCALE_PATHS_STORES` (store keys only:
 * `demo-boutique,shop.example`, or a lone `all` for every store host (LOCALE-PATHS-2); and NO language suffix: the default language is the store's own
 * `settings.defaultLanguage`, read at request time wherever it is needed, so it can never disagree with the store).
 * Missing, empty or unparseable = no store: it only ever fails closed.
 *
 * The middleware is synchronous and has no store, so it cannot answer "which language is the default". It therefore
 * only (a) rewrites a prefixed URL, (b) 301s a prefixed non-route (`/ar/nope`) to `/nope`, and (c) marks an unprefixed indexable URL
 * `x-locale-pending`; the root layout, which has the store, turns that into the redirect (`pendingRedirect`).
 */

export type PathLocale = 'ar' | 'en';

/** The first path segments that get a language prefix (the home is the empty path). */
export const LOCALE_PATH_ROOTS: readonly string[] = [
  'products',
  'categories',
  'blog',
  'about',
  'faq',
  'how-to-guides',
  'contact',
  'locations',
  'privacy',
  'terms',
  'returns',
  'shipping',
];
const ROOTS = new Set(LOCALE_PATH_ROOTS);

/**
 * Routes that are served UNDER a language prefix but are not indexable (Ruling LOCALE-PATHS-4, QA 2026-11-11: `/en/cart`
 * 301'd to `/cart` and an English shopper fell into Arabic). `/en/cart` is rewritten to `/cart` with the URL's language
 * on the request; the unprefixed `/cart` is NOT redirected (no `pending`: it is noindex and has no canonical to protect).
 * RULE: every storefront route honours the locale prefix and never strips it (ebda-foundation standard/storefront-locale-routes.md).
 */
const LOCALE_SERVED_ROOTS: readonly string[] = [
  'cart',
  'checkout',
  'account',
  'auth',
  'search',
  'wishlist',
  'compare',
  'review',
  'bundles',
  'looks',
  'size-guide',
  'affiliate',
  'q',
  'pages', // /pages/<slug>: a merchant's custom page (served under both prefixes, not redirected)
  'o', // /o/<token>: the WhatsApp cash-on-delivery confirmation page (#811)
];
const SERVED_ROOTS = new Set(LOCALE_SERVED_ROOTS);

/** Request headers the middleware asserts on a prefixed page, read by the root layout and the metadata helpers. */
export const LOCALE_PATH_HEADER = 'x-locale-path';
export const LOCALE_REST_HEADER = 'x-locale-rest';
/** Set on an UNPREFIXED indexable request of a locale-path store: the root layout redirects it (it has the store). */
export const LOCALE_PENDING_HEADER = 'x-locale-pending';
export const LOCALE_SEARCH_HEADER = 'x-locale-search';

/** The lone token that opts EVERY store host in (Ruling LOCALE-PATHS-2). */
const ALL_STORES = 'all';
const STORE_TOKEN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/** `STOREFRONT_LOCALE_PATHS_STORES` -> the store keys; null when missing/empty/unparseable (a `:ar` suffix is rejected). */
export function parseLocalePathStores(raw: string | undefined): Set<string> | null {
  if (raw === undefined) return null;
  const tokens = raw
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  // A LONE `all` is the explicit full-rollout value (Ruling LOCALE-PATHS-2, same shape as TENANT_ROUTING_ROUTES=all);
  // `all` mixed with anything else stays unparseable, so a typo can never half-widen the list.
  if (tokens.length === 1 && tokens[0] === ALL_STORES) return new Set([ALL_STORES]);
  const stores = new Set<string>();
  for (const token of tokens) {
    if (token === 'all' || !STORE_TOKEN.test(token)) return null;
    stores.add(token);
  }
  return stores;
}

/** Whether language-in-the-URL is ON for this store. Read env INSIDE the request (Workers). */
export function localePathsOn(
  storeKey: string,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (env.STOREFRONT_LOCALE_PATHS !== 'true') return false;
  const stores = parseLocalePathStores(env.STOREFRONT_LOCALE_PATHS_STORES);
  if (!stores) return false;
  return stores.has(ALL_STORES) || stores.has(storeKey.toLowerCase());
}

/** The allowlist identity of a host: the slug of `<slug>.ebda.app`, the hostname of a custom domain. */
export function storeKeyForHost(host: string, suffix = '.ebda.app'): string {
  const h = host.toLowerCase().split(':')[0];
  return h.endsWith(suffix) ? h.slice(0, -suffix.length) : h;
}

/** `/ar`, `/ar/`, `/ar/products` -> { locale: 'ar', rest: '/' | '/products' }; anything else null. */
export function splitLocalePrefix(pathname: string): { locale: PathLocale; rest: string } | null {
  const m = /^\/(ar|en)(\/.*)?$/.exec(pathname);
  if (!m) return null;
  return { locale: m[1] as PathLocale, rest: m[2] && m[2] !== '/' ? m[2] : '/' };
}

/** Whether `rest` (an unprefixed path) is one of the routes that carry a language prefix. */
export function isLocalePathRoute(rest: string): boolean {
  if (rest === '/' || rest === '') return true;
  return ROOTS.has(rest.replace(/^\//, '').split('/')[0]);
}

/** Whether `rest` is a route served under a language prefix, indexable or not. */
function isLocaleServedRoute(rest: string): boolean {
  if (isLocalePathRoute(rest)) return true;
  return SERVED_ROOTS.has(rest.replace(/^\//, '').split('/')[0]);
}

/** The prefixed path of `rest`: (`ar`, `/`) -> `/ar`, (`ar`, `/products`) -> `/ar/products`. */
export function prefixedPath(locale: PathLocale, rest: string): string {
  return `/${locale}${rest === '/' || rest === '' ? '' : rest}`;
}

export type LocalePathDecision =
  | { kind: 'none' }
  /** `/ar/nonexistent` -> `/nonexistent`: no such prefixed page, never a duplicate URL (a served route never lands here). */
  | { kind: 'redirect'; location: string }
  /** `/ar/products` -> serve `/products` in Arabic. */
  | { kind: 'rewrite'; locale: PathLocale; rest: string }
  /** `/products` (an old URL): the root layout redirects it once it has the store's default language. */
  | { kind: 'pending'; rest: string }
  /** `/en/manifest.webmanifest`: serve the one manifest route in that language (Ruling PWA-MANIFEST-2). */
  | { kind: 'manifest'; locale: PathLocale };

/** The one web app manifest route (`app/manifest.webmanifest/route.ts`). */
export const MANIFEST_PATH = '/manifest.webmanifest';

/**
 * The manifest a page links (Ruling PWA-MANIFEST-2). A browser fetches a manifest WITHOUT cookies, so the
 * `force-language` cookie never reaches it: the language has to be in the manifest's own URL. A page under
 * `/ar` or `/en` links `/<lang>/manifest.webmanifest`; a page with no language in its URL (a store without
 * locale paths, the cart, checkout) links the shared one, which answers in the store's default language.
 */
export function manifestHref(urlLocale: PathLocale | null): string {
  return urlLocale ? `/${urlLocale}${MANIFEST_PATH}` : MANIFEST_PATH;
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** What the (store-less) middleware does with one request to a store that has locale paths ON. */
export function decideLocalePath(a: {
  pathname: string;
  search: string;
  method: string;
}): LocalePathDecision {
  if (a.method !== 'GET' && a.method !== 'HEAD') return { kind: 'none' };
  const prefixed = splitLocalePrefix(a.pathname);
  if (prefixed) {
    if (isLocaleServedRoute(prefixed.rest))
      return { kind: 'rewrite', locale: prefixed.locale, rest: prefixed.rest };
    // Exactly this path, before the redirect below: redirected to the shared URL it would answer in the
    // store's default language again, which is the defect (Ruling PWA-MANIFEST-2).
    if (prefixed.rest === MANIFEST_PATH) return { kind: 'manifest', locale: prefixed.locale };
    // Open-redirect guard (Ruling LOCALE-PATHS-3): `/ar//evil.com` leaves rest = `//evil.com`, a protocol-relative URL.
    // A backslash anywhere (raw or %5C), or a decoded rest that starts with two slashes, is refused (no redirect, the
    // request falls through to a plain 404); leading slashes are otherwise collapsed so the target is always a path.
    const decoded = safeDecode(prefixed.rest);
    if (decoded.includes('\\') || /^\/\//.test(decoded)) return { kind: 'none' };
    return { kind: 'redirect', location: prefixed.rest.replace(/^\/+/, '/') + a.search };
  }
  if (!isLocalePathRoute(a.pathname)) return { kind: 'none' };
  return { kind: 'pending', rest: a.pathname };
}

/**
 * The redirect for an old, unprefixed URL, decided where the store is known (the root layout):
 * the store's default language when there is no preference (a permanent redirect must not depend on a cookie:
 * crawlers carry none), the visitor's cookie language when it differs (temporary).
 */
export function pendingRedirect(a: {
  rest: string;
  search: string;
  defaultLocale: PathLocale;
  cookieLocale?: string | null;
}): { location: string; permanent: boolean } {
  const cookie = a.cookieLocale === 'ar' || a.cookieLocale === 'en' ? a.cookieLocale : null;
  const target = cookie ?? a.defaultLocale;
  return {
    location: prefixedPath(target, a.rest) + a.search,
    permanent: target === a.defaultLocale,
  };
}

/**
 * The href a link must carry on a `/ar|/en` page. Internal links to an indexable route get the page's language prefix;
 * everything else is returned as is (external, `mailto:`, `#hash`, `?query`, cart/checkout/account/..., a link that
 * already has a prefix). `locale` null (an ordinary page) is the identity.
 */
export function localizeHref(href: string, locale: PathLocale | null): string {
  if (!locale || !href.startsWith('/') || href.startsWith('//')) return href;
  const q = href.search(/[?#]/);
  const path = q === -1 ? href : href.slice(0, q);
  const tail = q === -1 ? '' : href.slice(q);
  if (splitLocalePrefix(path)) return href;
  if (!isLocaleServedRoute(path)) return href;
  return prefixedPath(locale, path) + tail;
}

/** Canonical + reciprocal hreflang for one page of a locale-path store. `path` is the unprefixed route path. */
export function localeAlternates(a: {
  origin: string;
  path: string;
  locale: PathLocale;
  defaultLocale: PathLocale;
}): { canonical: string; languages: Record<string, string> } {
  const rest = a.path === '' ? '/' : a.path.startsWith('/') ? a.path : `/${a.path}`;
  const url = (l: PathLocale) => `${a.origin}${prefixedPath(l, rest)}`;
  return {
    canonical: url(a.locale),
    languages: { ar: url('ar'), en: url('en'), 'x-default': url(a.defaultLocale) },
  };
}

/**
 * `data` (a JSON-LD graph) with every URL that points at the store's own indexable pages moved to the page's language
 * prefix: `url`, `item` of a breadcrumb, `@id`, `mainEntityOfPage`, `target`... A string value that is exactly the origin
 * or starts with `origin + '/'` is treated as a store URL and localized like an href; every other value is untouched.
 * `locale` null (an ordinary page) returns `data` itself.
 */
export function localizeJsonLdUrls<T>(
  data: T,
  origin: string | readonly string[],
  locale: PathLocale | null
): T {
  if (!locale) return data;
  const bases = (typeof origin === 'string' ? [origin] : origin).map(o => o.replace(/\/$/, ''));
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      for (const base of bases) {
        if (v === base) return base + prefixedPath(locale, '/');
        if (v.startsWith(base + '/')) return base + localizeHref(v.slice(base.length), locale);
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)])
      );
    return v;
  };
  return walk(data) as T;
}

/**
 * A text document (`/llms.txt`) with every store URL moved to the language prefix: each `origin` followed by a path is
 * localized like an href (an indexable route gets the prefix; `/llms.txt`, `/sitemap.xml`, `/feeds/...`, cart... stay).
 * `locale` null returns `text` itself. Used with the store's DEFAULT language: one canonical URL per page, no redirect.
 */
export function localizeUrlsInText(
  text: string,
  origins: readonly string[],
  locale: PathLocale | null
): string {
  if (!locale) return text;
  let out = text;
  for (const raw of new Set(origins.map(o => o.replace(/\/$/, '')))) {
    const re = new RegExp(
      `${raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}((?:[/?#][^\\s)\\]"'<>]*)?)(?=$|[\\s)\\]"'<>,;])`,
      'g'
    );
    out = out.replace(re, (_m, rest: string) => {
      // the bare origin is the home page: its canonical URL is the prefix
      if (rest === '') return raw + localizeHref('/', locale);
      if (rest.startsWith('/')) return raw + localizeHref(rest, locale);
      return raw + rest;
    });
  }
  return out;
}
