import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { parseStoreHost, storeHost, type ParsedStoreHost, type PlatformApp } from '@ebda/shared';
// Relative import (not the `@/*` tsconfig alias) so this file is importable
// directly from the root Vitest suite, which has no per-workspace `@/*`
// alias plugin (each app's `@/*` points at its OWN `src/`, so a single
// global alias would be ambiguous across apps/{web,admin,api,orders}).
// Zero behavior change — Next.js resolves both forms identically.
import { devSuffixesAllowed } from './lib/platform-host';
import { studioHostResponse } from '../studio-host';
import { DEMO_LOOK_HEADER, parseDemoLook } from './lib/demo-look-param';
import {
  LOCALE_PATH_HEADER,
  LOCALE_PENDING_HEADER,
  LOCALE_REST_HEADER,
  LOCALE_SEARCH_HEADER,
  decideLocalePath,
  localePathsOn,
  type PathLocale,
} from './lib/locale-paths';

/**
 * HOST ROUTING (program plan §1, design cloudflare-backend §4).
 *
 * The Host header — and nothing else — says which store a request is for:
 *
 *   `<slug>.ebda.app`  → that store (resolved by the API from the slug)
 *   a custom domain    → that store (resolved by the API from the domain)
 *   `ebda.app`, `app.`, `api.`, … → the PLATFORM: never renders a store
 *   anything unparseable (IP, `localhost`, reserved label with no surface,
 *   `x.y.ebda.app`) → 404
 *
 * There is NO path-based `/<slug>` entry and NO sticky store cookie: a store
 * reached through a path or a cookie on a shared host was a cross-tenant cache
 * hazard (the same URL answering as different stores), and it is gone. Whether a
 * well-formed host actually belongs to a store is the API's call
 * (`GET /public/store/resolve`); middleware is synchronous and cannot ask, so
 * an unknown-but-well-formed host is 404'd by the page layer (`notFound()`).
 */

/**
 * Route roots eligible for the tenant-cacheable Track-A rewrite. Dark-
 * launched behind `STOREFRONT_TENANT_ROUTING` — see
 * `docs/plans/2026-07-12-tenant-cacheable-routing.md` §3.3/§4/§9 Phase 1.
 * Anonymous, non-personalized surfaces only (home is handled separately as
 * the empty-path case in `isCacheableTrackARoute`); every other route
 * (cart, checkout, account, auth, wishlist, search, compare, review, and
 * anything not listed here) stays on today's header-based resolution
 * untouched. Purely additive to `KNOWN_APP_ROUTES` above, not a replacement.
 */
const CACHEABLE_ROUTES = new Set([
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
]);

/** `pathname` is the (already slug-stripped, for platform domains) route the
 *  storefront will actually render — i.e. what `extractStoreSlug` returns as
 *  `rewrittenPath`, or the raw pathname on a custom domain. */
function isCacheableTrackARoute(pathname: string): boolean {
  if (pathname === '/' || pathname === '') return true;
  const firstSegment = pathname.replace(/^\//, '').split('/')[0];
  return CACHEABLE_ROUTES.has(firstSegment);
}

/**
 * Whether the dark-launched middleware rewrite is live. Read INSIDE the
 * request handler (never hoisted to module scope) — Cloudflare Workers
 * don't reliably expose `process.env` at module-eval time (see scoped
 * memory `feedback-workers-no-module-env-secrets`). Unset, or any value
 * other than the literal string `"true"`, is completely inert: every
 * branch below falls through to today's header-only resolution, byte-for-
 * byte unchanged. Never flipped on in Phase 1 (see plan §9) — Phase 2
 * flips it on a CF preview Worker only.
 */
function storefrontTenantRoutingEnabled(): boolean {
  return process.env.STOREFRONT_TENANT_ROUTING === 'true';
}

/** The token that names the home route (`/`) in
 *  `STOREFRONT_TENANT_ROUTING_ROUTES` — home has no first path segment. */
const HOME_ROUTE_TOKEN = 'home';

/** The token that means "every Track-A route" — the explicit value for the
 *  full rollout. It must be the only token in the list. */
const ALL_ROUTES_TOKEN = 'all';

/**
 * Parse `STOREFRONT_TENANT_ROUTING_ROUTES` into the routes it allows.
 * Returns `'all'`, a non-empty set of route tokens, or `null` for "no route".
 *
 * FAIL-CLOSED on every bad state (issue #1980). While the main flag is on:
 * - MISSING → no route. The two variables are set independently as Worker
 *   secrets, so losing this one must turn the rewrite off, never widen it to
 *   every Track-A route.
 * - EMPTY (or only commas/whitespace) → no route.
 * - UNPARSEABLE → no route. Any token that is not a `CACHEABLE_ROUTES` root,
 *   `home` or a lone `all` rejects the WHOLE list, so `about,fqa` does not
 *   quietly ship `/about` alone and `all,about` is not guessed at.
 *
 * Widening is always an explicit value change; the full rollout is `all`.
 */
function parseTenantRoutingRoutes(raw: string | undefined): 'all' | Set<string> | null {
  if (raw === undefined) return null;
  const tokens = raw
    .split(',')
    .map(token => token.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  if (tokens.includes(ALL_ROUTES_TOKEN)) return tokens.length === 1 ? 'all' : null;
  const known = tokens.every(token => token === HOME_ROUTE_TOKEN || CACHEABLE_ROUTES.has(token));
  return known ? new Set(tokens) : null;
}

/**
 * Route-scoped canary for the rewrite (plan §9 Phase 3: `/about` + `/faq`
 * first). `STOREFRONT_TENANT_ROUTING_ROUTES` is a comma list of
 * `CACHEABLE_ROUTES` roots (plus `home` for `/`), e.g. `about,faq`, or `all`.
 * Missing, empty or unparseable means NO route (see
 * `parseTenantRoutingRoutes`). The list can only ever NARROW
 * `CACHEABLE_ROUTES`: it cannot enable cart/checkout/etc, because
 * `isCacheableTrackARoute` is still required on top of it.
 *
 * Read INSIDE the request handler for the same Workers-env reason as the main
 * flag above. Has no effect at all while `STOREFRONT_TENANT_ROUTING` is off.
 */
function tenantRoutingRouteAllowed(pathname: string): boolean {
  const allowed = parseTenantRoutingRoutes(process.env.STOREFRONT_TENANT_ROUTING_ROUTES);
  if (allowed === null) return false;
  if (allowed === 'all') return true;
  const firstSegment = pathname.replace(/^\//, '').split('/')[0];
  return allowed.has(firstSegment === '' ? HOME_ROUTE_TOKEN : firstSegment);
}

/** A store token in `STOREFRONT_TENANT_ROUTING_STORES`: a platform slug, a
 *  store id, or a custom-domain hostname. Lowercase letters/digits, with `.`
 *  and `-` only between them. Anything else (`slug:x`, spaces, `*`, `/`)
 *  makes the whole list unparseable. */
const STORE_TOKEN_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/** The two render locales a store token may declare as its default. */
type TrackALocale = 'en' | 'ar';

/**
 * Parse `STOREFRONT_TENANT_ROUTING_STORES` into the stores the rewrite may
 * apply to (store -> its DEFAULT locale), or `null` for "no store". There is
 * deliberately NO `all` shortcut (Ruling TRC-6): the literal token `all` is
 * rejected like any other unparseable value, so the list can only ever name
 * stores one by one.
 *
 * A token may carry the store's default language after a colon, `demo-boutique:ar`
 * or `demo-shop.example:ar`; a bare token means `en`. Middleware is synchronous and
 * cannot read `settings.defaultLanguage`, but a cookie-less visitor to an
 * Arabic-default store must get Arabic in the route/cache key (issue 2419,
 * Ruling TRC-7). The suffix must be `en` or `ar`; anything else, or a second
 * colon, makes the WHOLE list unparseable (fail-closed).
 *
 * FAIL-CLOSED on every bad state, like the route list (#1980): MISSING, EMPTY
 * (or only commas/whitespace) and UNPARSEABLE all route NO store, even with
 * the main flag on and a valid route list. Losing this variable turns the
 * canary off; it never widens it.
 */
function parseTenantRoutingStores(raw: string | undefined): Map<string, TrackALocale> | null {
  if (raw === undefined) return null;
  const tokens = raw
    .split(',')
    .map(token => token.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const stores = new Map<string, TrackALocale>();
  for (const token of tokens) {
    const parts = token.split(':');
    if (parts.length > 2) return null;
    const [store, lang = 'en'] = parts;
    if (store === ALL_ROUTES_TOKEN || !STORE_TOKEN_PATTERN.test(store)) return null;
    if (lang !== 'en' && lang !== 'ar') return null;
    stores.set(store, lang);
  }
  return stores;
}

/**
 * Per-store scope for the rewrite. One Worker serves every store, so the two
 * flags above are Worker-wide; this list is what lets a canary target one
 * store (Ruling TRC-6). `storeKey` is the same identity the rewrite target
 * carries (`buildStoreTreeUrl`'s `tenantKey`): the path/cookie slug on a
 * platform host, or the normalized custom-domain hostname. Middleware is
 * synchronous and cannot look a custom domain up to find its slug, so a custom
 * domain is allowlisted by its HOSTNAME (`demo-store.example`); a bare slug
 * token never matches a custom domain. Read INSIDE the request handler.
 */
function tenantRoutingStoreAllowed(storeKey: string): boolean {
  return (
    parseTenantRoutingStores(process.env.STOREFRONT_TENANT_ROUTING_STORES)?.has(
      storeKey.toLowerCase()
    ) ?? false
  );
}

/** The default locale an allowlisted store declared (`en` when none). */
function tenantRoutingStoreDefaultLocale(storeKey: string): TrackALocale {
  return (
    parseTenantRoutingStores(process.env.STOREFRONT_TENANT_ROUTING_STORES)?.get(
      storeKey.toLowerCase()
    ) ?? 'en'
  );
}

/** Resolve the locale that gets baked into the `/tenant-store/[tenant]/[locale]`
 *  rewrite target. Mirrors the root layout's decision (`app/layout.tsx`): the
 *  `force-language` cookie when it is `en` or `ar`, otherwise the store's
 *  default language. Runs in middleware, so it decides the CACHE KEY itself
 *  instead of forcing dynamic rendering to read the cookie at render time
 *  (plan §7). A cookie-less visitor therefore no longer shares the `en` key on
 *  an Arabic-default store (issue 2419, Ruling TRC-7). `storeKey` is the
 *  allowlist identity; the default comes from its `:ar` / `:en` suffix. */
function resolveTrackALocale(request: NextRequest, storeKey: string): TrackALocale {
  const cookie = request.cookies.get('force-language')?.value;
  if (cookie === 'ar' || cookie === 'en') return cookie;
  return tenantRoutingStoreDefaultLocale(storeKey);
}

/** Build the internal (never customer-visible) rewrite target for the
 *  tenant-cacheable Track-A tree. `tenantKey` is the request HOST
 *  (`amelia.ebda.app` or a custom domain), so the route's full-route-cache key
 *  carries the host and store A's HTML can never be served for store B's host.
 *  `storeKey` is the allowlist identity (the bare slug for a `<slug>.ebda.app`
 *  host, the hostname for a custom domain). */
function buildStoreTreeUrl(
  request: NextRequest,
  tenantKey: string,
  pathname: string,
  storeKey: string,
  /** The language carried by a `/ar|/en` URL (LOCALE-PATHS-1): it wins over the cookie. */
  urlLocale?: PathLocale
): URL {
  const locale = urlLocale ?? resolveTrackALocale(request, storeKey);
  const url = request.nextUrl.clone();
  const suffix = pathname === '/' ? '' : pathname;
  url.pathname = `/tenant-store/${encodeURIComponent(tenantKey)}/${locale}${suffix}`;
  return url;
}

/**
 * Preview-draft cookie policy, as a response decorator.
 *
 * The admin page-builder iframe always carries `?_preview=<tick>`; a normal
 * visitor never does. That flag — not the presence of `?_layoutDraft` — is what
 * distinguishes an admin preview from a real visit, so it gates BOTH directions:
 * inside the iframe the draft token is persisted, outside it any stale draft
 * cookie is cleared immediately. Without the clear, unsaved admin edits leak to
 * a real storefront visitor who previewed in the same browser (2026-05-28).
 *
 * SameSite=None + Secure so it survives the cross-site iframe context
 * (store.ebda.app framing demo-shop.example). TTL 1h matches Redis.
 */
function applyDraftCookie(
  request: NextRequest,
  draftToken: string | null,
  isPreviewIframe: boolean
) {
  return (response: NextResponse): NextResponse => {
    if (draftToken && isPreviewIframe) {
      response.cookies.set('force-preview-draft', draftToken, {
        path: '/',
        maxAge: 3600,
        sameSite: 'none',
        secure: true,
        httpOnly: true,
      });
    } else if (!isPreviewIframe) {
      const staleDraft = request.cookies.get('force-preview-draft')?.value;
      if (staleDraft) {
        response.cookies.set('force-preview-draft', '', {
          path: '/',
          maxAge: 0,
          sameSite: 'none',
          secure: true,
          httpOnly: true,
        });
      }
    }
    return response;
  };
}

/**
 * Propagate the draft token as a REQUEST header so server components in the SAME
 * request can read it — cookies set on a response are not visible to that
 * response's own server components.
 *
 * Two ways in: the initial iframe load carries `?_layoutDraft`, and subsequent
 * Link clicks inside the iframe drop it (but keep `?_preview`), so the cookie
 * carries it from then on. A normal visitor gets neither, so layout.tsx serves
 * the committed layout.
 */
function propagateDraftHeader(
  requestHeaders: Headers,
  request: NextRequest,
  draftToken: string | null,
  isPreviewIframe: boolean
): void {
  if (draftToken && isPreviewIframe) {
    requestHeaders.set('x-preview-draft', draftToken);
    return;
  }
  if (isPreviewIframe) {
    const cookieDraft = request.cookies.get('force-preview-draft')?.value;
    if (cookieDraft) requestHeaders.set('x-preview-draft', cookieDraft);
  }
}

/**
 * The dark-launch gate for tenant-cacheable routing (Phase 1), which was spelled
 * out identically at three call sites — custom domain, path slug, cookie slug.
 * Inert unless STOREFRONT_TENANT_ROUTING=true, never applied to the admin preview
 * iframe, and only for Track-A allowlisted routes that the
 * STOREFRONT_TENANT_ROUTING_ROUTES canary list names (missing/empty/unparseable
 * list = no route), and only for a store that STOREFRONT_TENANT_ROUTING_STORES
 * names (missing/empty/unparseable list = no store, Ruling TRC-6).
 * See docs/plans/2026-07-12-tenant-cacheable-routing.md §3.3/§9.
 */
function isTenantTreeEligible(
  pathname: string,
  isPreviewIframe: boolean,
  storeKey: string
): boolean {
  return (
    storefrontTenantRoutingEnabled() &&
    !isPreviewIframe &&
    isCacheableTrackARoute(pathname) &&
    tenantRoutingRouteAllowed(pathname) &&
    tenantRoutingStoreAllowed(storeKey)
  );
}

/**
 * Store-host requests (`<slug>.ebda.app` or a custom domain): the Host itself
 * identifies the store. `host` is the normalised hostname; `storeKey` is the
 * canary-allowlist identity (slug for a subdomain, hostname for a custom domain).
 */
function handleStoreHost(
  request: NextRequest,
  host: string,
  storeKey: string,
  requestHeaders: Headers,
  isPreviewIframe: boolean
): NextResponse {
  requestHeaders.set('x-store-domain', host);
  requestHeaders.set('x-store-identifier', host);
  // Asserted explicitly (not just left absent) so layout.tsx can tell
  // "store host" apart from "middleware never ran" — the latter is the only
  // case where StoreProvider's client-side host detection should run (#2091).
  requestHeaders.set('x-is-platform', 'false');

  // Demo-showroom look preview: a well-formed `?look=<id>` is forwarded as a REQUEST header (the
  // client-sent one was stripped in `middleware`), for the resolver to apply to an `isDemo` store
  // only. Such a request is per-visitor by construction: it never takes the shared tenant-tree
  // (full-route-cache) rewrite and its response is `private, no-store`, so a previewed look can
  // never be cached and served to another visitor or another store (the Worker's demo edge cache,
  // Ruling DEMO-EDGE-1, re-keys by look and caches the DEMO hosts only). Middleware is synchronous and
  // cannot ask whether the store is a demo, so the guard covers every store host; the page for a
  // non-demo store is identical to the one without the param.
  const demoLook = parseDemoLook(request.nextUrl.searchParams.get('look'));
  if (demoLook) requestHeaders.set(DEMO_LOOK_HEADER, demoLook);
  const uncacheableForDemoLook = (response: NextResponse): NextResponse => {
    if (demoLook) response.headers.set('Cache-Control', 'private, no-store');
    return response;
  };

  // /favicon.ico → dynamic per-store favicon (falling back to the neutral
  // platform default when the store has none). The `sf=1` marker is set by the
  // route handler's own fallback redirect, so this cannot loop.
  if (request.nextUrl.pathname === '/favicon.ico' && !request.nextUrl.searchParams.has('sf')) {
    const url = request.nextUrl.clone();
    url.pathname = '/api/store-favicon';
    return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  }

  // Language in the URL (Ruling LOCALE-PATHS-1): only for a store that opted in, never inside the admin preview
  // iframe, never for a demo-look preview. See `src/lib/locale-paths.ts` for the rules.
  const localePaths = !isPreviewIframe && !demoLook && localePathsOn(storeKey);
  if (localePaths) {
    const decision = decideLocalePath({
      pathname: request.nextUrl.pathname,
      search: request.nextUrl.search,
      method: request.method,
    });
    if (decision.kind === 'redirect') {
      return NextResponse.redirect(new URL(decision.location, request.url), 301);
    }
    if (decision.kind === 'pending') {
      // An old unprefixed URL. Only the root layout knows the store's default language (middleware has no store),
      // so it does the redirect; the request carries what it needs. Never cacheable as a page in the meantime.
      requestHeaders.set(LOCALE_PENDING_HEADER, '1');
      requestHeaders.set(LOCALE_REST_HEADER, decision.rest);
      requestHeaders.set(LOCALE_SEARCH_HEADER, request.nextUrl.search);
      const pending = NextResponse.next({ request: { headers: requestHeaders } });
      pending.headers.set('x-store-domain', host);
      pending.headers.set('Cache-Control', 'private, no-store');
      return pending;
    }
    if (decision.kind === 'rewrite') {
      requestHeaders.set(LOCALE_PATH_HEADER, decision.locale);
      requestHeaders.set(LOCALE_REST_HEADER, decision.rest);
      let target: URL;
      if (isTenantTreeEligible(decision.rest, isPreviewIframe, storeKey)) {
        target = buildStoreTreeUrl(request, host, decision.rest, storeKey, decision.locale);
      } else {
        target = request.nextUrl.clone();
        target.pathname = decision.rest;
      }
      const response = NextResponse.rewrite(target, { request: { headers: requestHeaders } });
      response.headers.set('x-store-domain', host);
      // The URL decides the language; keep the cookie in step so the unprefixed pages (cart, checkout) match.
      if (request.cookies.get('force-language')?.value !== decision.locale) {
        response.cookies.set('force-language', decision.locale, {
          path: '/',
          maxAge: 31536000,
          sameSite: 'lax',
          secure: true,
        });
      }
      return response;
    }
  }

  if (!demoLook && isTenantTreeEligible(request.nextUrl.pathname, isPreviewIframe, storeKey)) {
    const storeTreeUrl = buildStoreTreeUrl(request, host, request.nextUrl.pathname, storeKey);
    const response = NextResponse.rewrite(storeTreeUrl, {
      request: { headers: requestHeaders },
    });
    response.headers.set('x-store-domain', host);
    return response;
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('x-store-domain', host);
  return uncacheableForDemoLook(response);
}

/** Platform apps this Worker serves directly (the rest are other Workers/sites). */
const SERVED_PLATFORM_APPS: ReadonlySet<PlatformApp> = new Set<PlatformApp>([
  'marketing',
  'preview',
]);

/**
 * Platform-host requests: NEVER a store. `x-is-platform: true` and NO store
 * identifier, so every store-dependent page 404s (or, for `/`, redirects to the
 * marketing site) instead of rendering anything tenant-shaped.
 */
function handlePlatformHost(requestHeaders: Headers): NextResponse {
  requestHeaders.set('x-is-platform', 'true');
  return NextResponse.next({ request: { headers: requestHeaders } });
}

/**
 * A host nobody serves. A bare label under `.ebda.app` gets Ebda AI Studio's branded page (a real 404, or
 * a 200 "coming soon" for the named upcoming products); an IP, junk or another zone stays the plain 404.
 */
function unservedHostResponse(request: NextRequest, hostname: string): NextResponse {
  const studio = studioHostResponse(
    hostname,
    request.headers.get('accept-language'),
    request.nextUrl.searchParams.get('lang')
  );
  return studio ? studio.response : notFoundResponse();
}

function notFoundResponse(): NextResponse {
  return new NextResponse('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * Request headers only this middleware may assert. `requestHeaders` is seeded
 * from the RAW client request, so without this strip a caller can send any of
 * them and the server components / route handlers downstream take it as the
 * middleware's word: a spoofed `x-is-platform` flips SSR link shape (#2153), a
 * spoofed `x-store-domain` on a platform URL makes `/llms.txt` and
 * `/feeds/products.json` answer as another store under a `public, s-maxage`
 * header, and a spoofed `x-preview-draft` would render a draft layout outside
 * the preview iframe. Every value in this list is re-set below from the Host,
 * the URL or the preview params — never from the client. The retired
 * `x-store-slug*` headers stay in the list: nothing sets them any more, and
 * stripping them means a client can never smuggle one in as a store identity.
 */
export const MIDDLEWARE_ASSERTED_HEADERS = [
  'x-is-platform',
  'x-store-slug',
  'x-store-slug-source',
  'x-store-domain',
  'x-store-identifier',
  'x-preview-draft',
  'x-builder-preview-token',
  'x-original-host',
  // Demo-showroom look preview; re-set below only from a validated `?look=`.
  'x-demo-look',
  // Language-in-URL (LOCALE-PATHS-1); re-set below only from a validated `/ar|/en` prefix.
  LOCALE_PATH_HEADER,
  LOCALE_PENDING_HEADER,
  LOCALE_REST_HEADER,
  LOCALE_SEARCH_HEADER,
] as const;

export function middleware(request: NextRequest) {
  const hostname = request.headers.get('host') || '';

  // /tenant-store/* is an INTERNAL rewrite target only (rewrites don't re-enter
  // middleware, so this guard never sees them). A direct external hit would
  // bypass the Host→tenant binding — any domain could render any tenant's
  // storefront (cross-tenant boundary violation + duplicate-content SEO surface),
  // flag on or off, because the route tree exists in the build regardless.
  // Client-side navigation is unaffected: Next keeps the ORIGINAL URL for RSC
  // requests through a rewrite, so real traffic never addresses this path.
  if (request.nextUrl.pathname.startsWith('/tenant-store/')) {
    return new NextResponse(null, { status: 404 });
  }

  const parsedHost = parseStoreHost(hostname, { allowDevSuffixes: devSuffixesAllowed() });

  // An IP, `localhost`, a reserved label with no surface (`store.ebda.app`), a
  // multi-label name under `.ebda.app` or any malformed Host is never a store
  // and never a page: 404, with no store lookup and nothing cacheable.
  if (parsedHost.kind === 'invalid') return unservedHostResponse(request, hostname);

  // www → apex canonical 301: for CUSTOM store domains, and for the platform's
  // own `www.ebda.app`. The www custom hostname is enrolled in
  // Cloudflare-for-SaaS (CloudflareDomainService.addDomain) so TLS terminates
  // before we reach here; we then send visitors to the single canonical apex.
  const bareHost = hostname.split(':')[0].toLowerCase().replace(/\.$/, '');
  if (
    bareHost.startsWith('www.') &&
    (parsedHost.kind === 'custom' || parsedHost.kind === 'platform')
  ) {
    const apexUrl = new URL(
      request.nextUrl.pathname + request.nextUrl.search,
      `https://${bareHost.replace(/^www\./, '')}`
    );
    return NextResponse.redirect(apexUrl, 301);
  }

  // Platform hosts this Worker does not serve (app., api., orders., docs., …) are
  // misrouted traffic, not pages.
  if (parsedHost.kind === 'platform' && !SERVED_PLATFORM_APPS.has(parsedHost.app)) {
    return unservedHostResponse(request, hostname);
  }

  const draftToken = request.nextUrl.searchParams.get('_layoutDraft');
  const isPreviewIframe = request.nextUrl.searchParams.has('_preview');
  const withDraftCookie = applyDraftCookie(request, draftToken, isPreviewIframe);

  const requestHeaders = new Headers(request.headers);
  for (const name of MIDDLEWARE_ASSERTED_HEADERS) requestHeaders.delete(name);
  requestHeaders.set('x-original-host', hostname);
  propagateDraftHeader(requestHeaders, request, draftToken, isPreviewIframe);

  // Visual-builder canvas (`/?_preview=…&_builder=<token>`): forward the token as
  // a REQUEST header so the store resolver can present it to the API, which
  // verifies it server-side before resolving a not-yet-active store. Gated on
  // `_preview` exactly like app/page.tsx; the client-sent header was stripped
  // above, so only this URL-derived value can reach the resolver.
  const builderToken = request.nextUrl.searchParams.get('_builder');
  const isBuilderCanvas = isPreviewIframe && !!builderToken;
  if (isBuilderCanvas) requestHeaders.set('x-builder-preview-token', builderToken);

  const response = withDraftCookie(
    routeByHost(request, parsedHost, requestHeaders, isPreviewIframe)
  );
  if (isBuilderCanvas) {
    // A canvas response may carry an unpublished store: never cacheable or indexable.
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  }
  return response;
}

/** Dispatch a classified, non-invalid host. */
function routeByHost(
  request: NextRequest,
  parsedHost: Exclude<ParsedStoreHost, { kind: 'invalid' }>,
  requestHeaders: Headers,
  isPreviewIframe: boolean
): NextResponse {
  switch (parsedHost.kind) {
    case 'subdomain':
      // The store's slug is the allowlist identity; the canonical HOST
      // (`<slug>.ebda.app`, also for the dev-only `.localhost` suffixes) is what
      // the API resolves and what the tenant tree is keyed on.
      return handleStoreHost(
        request,
        storeHost(parsedHost.slug),
        parsedHost.slug,
        requestHeaders,
        isPreviewIframe
      );
    case 'custom':
      return handleStoreHost(
        request,
        parsedHost.hostname,
        parsedHost.hostname,
        requestHeaders,
        isPreviewIframe
      );
    case 'platform':
      return handlePlatformHost(requestHeaders);
  }
}

/**
 * Configure which paths the middleware should run on
 * We run on all paths except static files and API routes
 */
export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - sw.js
     * - public folder
     * - .well-known/security.txt (RFC 9116 — must serve the STATIC file on
     *   every host, incl. custom domains, without tenant rewrites). Narrowed
     *   from the whole `.well-known/` directory on 2026-09-11: the ACP and UCP
     *   discovery documents live there too and are PER-STORE, so they need the
     *   same `x-store-slug` / `x-store-domain` headers `/llms.txt` gets. With
     *   the directory excluded they saw no store context at all and every
     *   custom-domain merchant would have served the platform's answer.
     * - api routes (handled separately, EXCEPT /api/store-favicon which the
     *   favicon.ico rewrite below targets — matcher excludes `api/` broadly,
     *   but the rewrite target itself never re-enters this matcher since
     *   `/api/store-favicon` is excluded by the `api/` pattern, which is what
     *   we want: middleware runs once on `/favicon.ico`, not again on the
     *   rewritten destination)
     *
     * manifest.webmanifest is NOT excluded either (it was, from 2026-03-16,
     * "so it is not treated as a store slug" — `extractStoreSlug` has since
     * skipped any dotted first segment, so that reason is gone). Excluded, it
     * never received `x-store-domain` / `x-store-slug`, so `app/manifest.ts`'s
     * `getStore()` resolved NO store and every custom-domain merchant served
     * the platform's "Force" manifest — verified live on demo-store.example
     * 2026-10-01. It must see the same store context every page gets.
     *
     * favicon.ico is intentionally NOT excluded here (removed 2026-07-02) so
     * custom-domain stores can get a per-store favicon (see the
     * `x-store-domain` branch above). This does NOT change platform-domain
     * (ebda.app etc) behavior: getStoreIdentifier() returns null for
     * platform hosts, so those requests fall through this middleware to
     * NextResponse.next() with no rewrite, and Next serves the static
     * /public/favicon.ico exactly as before.
     */
    '/((?!_next/static|_next/image|sw\\.js|api/|public/|\\.well-known/security\\.txt).*)',
  ],
};
