import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
// Relative import (not the `@/*` tsconfig alias) so this file is importable
// directly from the root Vitest suite, which has no per-workspace `@/*`
// alias plugin (each app's `@/*` points at its OWN `src/`, so a single
// global alias would be ambiguous across apps/{web,admin,api,orders}).
// Zero behavior change — Next.js resolves both forms identically.
import { isPlatformHost } from './src/lib/platform-host';

/**
 * Check if a hostname is a platform domain (not a custom store domain).
 * Delegates to the shared `isPlatformHost` so the server (this middleware) and
 * the client (`useStoreUrl` in StoreContext) can never drift — drift is exactly
 * what broke store.force-ai.co (see `lib/platform-host.ts`).
 */
function isPlatformDomain(hostname: string): boolean {
  return isPlatformHost(hostname);
}

/**
 * Extract the store identifier from a custom domain.
 * Normalizes the domain: strips www prefix, lowercases, removes port.
 * For custom domains, the normalized domain is the identifier.
 */
function getStoreIdentifier(hostname: string): string | null {
  const host = hostname
    .split(':')[0]
    .toLowerCase()
    .replace(/^www\./, '');

  if (isPlatformDomain(hostname)) {
    return null;
  }

  return host;
}

/**
 * Known app routes that should NOT be treated as store slugs
 */
const KNOWN_APP_ROUTES = new Set([
  'products',
  'cart',
  'checkout',
  'auth',
  'account',
  'about',
  'faq',
  'contact',
  'search',
  'compare',
  'categories',
  'privacy',
  'terms',
  'returns',
  'shipping',
  'wishlist',
  'review',
  // Campaign-email unsubscribe landing page (D2) — linked from every campaign
  // email as <storefront>/unsubscribe?token=…, including platform-path stores.
  'unsubscribe',
  '_next',
  'api',
  'manifest',
  'error',
  'not-found',
  // Reserved Next.js file-based metadata routes (no file extension, so the
  // `firstSegment.includes('.')` check below doesn't catch them). Without these
  // the platform domain treats e.g. /opengraph-image as a store slug and serves
  // HTML, breaking WhatsApp/social link-preview images + favicons.
  'opengraph-image',
  'twitter-image',
  'icon',
  'apple-icon',
  'sitemap',
  'robots',
  // Platform-level routes (not store-scoped) — must never be read as a store
  // slug on the platform domain, or store.forcemediakw.com/<route> resolves to a
  // nonexistent store and 404s. `og` is the store-aware OG-card route
  // (GET /og?slug=…) used by social link previews; `landing-preview` is the
  // redesigned-landing preview page.
  'og',
  'landing-preview',
  // Static asset folder for the landing preview (e.g. /landing/after-store.jpg).
  // Without this the platform domain treats `landing` as a store slug and 404s
  // the image.
  'landing',
  // Static asset folder for the social brand icons (e.g. /social-icons/whatsapp.png).
  // The file extension is on the 2nd segment, so the `firstSegment.includes('.')`
  // check below doesn't catch it — without this the platform domain reads
  // `social-icons` as a store slug and 404s the footer/widget brand icons (they
  // worked on custom domains but broke on store.forcemediakw.com/<slug>).
  'social-icons',
  // /feeds/products.json — the agent_feed storefront route. The file
  // extension is on the 2nd segment (products.json), so the
  // `firstSegment.includes('.')` check below doesn't catch `feeds` — without
  // this the platform domain reads `feeds` as a store slug and 404s.
  'feeds',
]);

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

/**
 * Parse `STOREFRONT_TENANT_ROUTING_STORES` into the set of stores the rewrite
 * may apply to, or `null` for "no store". There is deliberately NO `all`
 * shortcut (Ruling TRC-6): the literal token `all` is rejected like any other
 * unparseable value, so the list can only ever name stores one by one.
 *
 * FAIL-CLOSED on every bad state, like the route list (#1980): MISSING, EMPTY
 * (or only commas/whitespace) and UNPARSEABLE (any token failing
 * `STORE_TOKEN_PATTERN`, or the reserved `all`) all route NO store, even with
 * the main flag on and a valid route list. Losing this variable turns the
 * canary off; it never widens it.
 */
function parseTenantRoutingStores(raw: string | undefined): Set<string> | null {
  if (raw === undefined) return null;
  const tokens = raw
    .split(',')
    .map(token => token.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const valid = tokens.every(
    token => token !== ALL_ROUTES_TOKEN && STORE_TOKEN_PATTERN.test(token)
  );
  return valid ? new Set(tokens) : null;
}

/**
 * Per-store scope for the rewrite. One Worker serves every store, so the two
 * flags above are Worker-wide; this list is what lets a canary target one
 * store (Ruling TRC-6). `storeKey` is the same identity the rewrite target
 * carries (`buildStoreTreeUrl`'s `tenantKey`): the path/cookie slug on a
 * platform host, or the normalized custom-domain hostname. Middleware is
 * synchronous and cannot look a custom domain up to find its slug, so a custom
 * domain is allowlisted by its HOSTNAME (`pecannbee.com.kw`); a bare slug
 * token never matches a custom domain. Read INSIDE the request handler.
 */
function tenantRoutingStoreAllowed(storeKey: string): boolean {
  const allowed = parseTenantRoutingStores(process.env.STOREFRONT_TENANT_ROUTING_STORES);
  if (allowed === null) return false;
  return allowed.has(storeKey.toLowerCase());
}

/** Resolve the locale that gets baked into the `/tenant-store/[tenant]/[locale]`
 *  rewrite target. Mirrors the cookie read in `app/layout.tsx` (`force-
 *  language`), but — unlike the layout — this runs in middleware, so it
 *  can decide the CACHE KEY itself instead of forcing dynamic rendering to
 *  read the cookie at render time (plan §7). Falls back to `en` when the
 *  cookie is absent; a store's own `defaultLanguage` preference isn't
 *  available here without an extra store fetch, so honoring it is deferred
 *  to a later phase (see PR notes) — inert either way while the flag is off. */
function resolveTrackALocale(request: NextRequest): 'en' | 'ar' {
  return request.cookies.get('force-language')?.value === 'ar' ? 'ar' : 'en';
}

/** Build the internal (never customer-visible) rewrite target for the
 *  tenant-cacheable Track-A tree. `tenantKey` is either a normalized custom
 *  domain or `slug:<slug>` for platform-path stores (plan §3.3);
 *  `encodeURIComponent` keeps the `slug:` colon path-segment-safe — Next
 *  decodes it back on the way into `params.tenant`. */
function buildStoreTreeUrl(request: NextRequest, tenantKey: string, pathname: string): URL {
  const locale = resolveTrackALocale(request);
  const url = request.nextUrl.clone();
  const suffix = pathname === '/' ? '' : pathname;
  url.pathname = `/tenant-store/${encodeURIComponent(tenantKey)}/${locale}${suffix}`;
  return url;
}

/**
 * Extract store slug from the first path segment on platform domains.
 * Returns the slug and the remaining path, or null if the first segment is a known route.
 */
function extractStoreSlug(pathname: string): { slug: string; rewrittenPath: string } | null {
  // Remove leading slash and split
  const segments = pathname.replace(/^\//, '').split('/');
  const firstSegment = segments[0];

  if (!firstSegment || KNOWN_APP_ROUTES.has(firstSegment)) {
    return null;
  }

  // Skip anything that looks like a file (contains a dot) — e.g.
  // robots.txt, sitemap.xml, favicon.ico, manifest.webmanifest, *.js
  if (firstSegment.includes('.')) {
    return null;
  }

  // The first segment is a potential store slug
  const remainingSegments = segments.slice(1);
  const rewrittenPath = '/' + remainingSegments.join('/') || '/';

  return { slug: firstSegment, rewrittenPath };
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
 * (admin.forcemediakw.com framing wadyaljuz.com). TTL 1h matches Redis.
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

/** Custom-domain requests: the Host itself identifies the store. */
function handleCustomDomain(
  request: NextRequest,
  storeIdentifier: string,
  requestHeaders: Headers,
  isPreviewIframe: boolean
): NextResponse {
  requestHeaders.set('x-store-domain', storeIdentifier);
  requestHeaders.set('x-store-identifier', storeIdentifier);
  // Asserted explicitly (not just left absent) so layout.tsx can tell
  // "custom domain" apart from "middleware never ran" — the latter is the only
  // case where StoreProvider's client-side host detection should run (#2091).
  requestHeaders.set('x-is-platform', 'false');
  // Host-resolved, never cookie-resolved — clear any client-supplied value
  // (requestHeaders is seeded from the raw request) so a custom-domain
  // response is never wrongly marked non-shared-cacheable.
  requestHeaders.delete('x-store-slug-source');

  // Custom-domain /favicon.ico → dynamic per-store favicon (falling back to the
  // neutral platform default when the store has none). Unreachable on a platform
  // host, where getStoreIdentifier returns null, so the shared-domain
  // /favicon.ico keeps serving the static asset. The `sf=1` marker is set by the
  // route handler's own fallback redirect, so this cannot loop.
  if (request.nextUrl.pathname === '/favicon.ico' && !request.nextUrl.searchParams.has('sf')) {
    const url = request.nextUrl.clone();
    url.pathname = '/api/store-favicon';
    return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  }

  if (isTenantTreeEligible(request.nextUrl.pathname, isPreviewIframe, storeIdentifier)) {
    const storeTreeUrl = buildStoreTreeUrl(request, storeIdentifier, request.nextUrl.pathname);
    const response = NextResponse.rewrite(storeTreeUrl, {
      request: { headers: requestHeaders },
    });
    response.headers.set('x-store-domain', storeIdentifier);
    return response;
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('x-store-domain', storeIdentifier);
  return response;
}

/** Platform-domain requests: the store comes from the path slug, or the cookie. */
function handlePlatformDomain(
  request: NextRequest,
  requestHeaders: Headers,
  isPreviewIframe: boolean
): NextResponse {
  requestHeaders.set('x-is-platform', 'true');
  // requestHeaders is seeded from the raw client request, so a caller could
  // send this header themselves. Clear it first so only the cookie-fallback
  // branch below (the sole `.set` for this header) can ever turn it on —
  // otherwise a spoofed value could force a legitimately URL-resolved
  // response into the private/non-shared-cacheable path below.
  requestHeaders.delete('x-store-slug-source');

  const slugInfo = extractStoreSlug(request.nextUrl.pathname);
  if (slugInfo) {
    requestHeaders.set('x-store-slug', slugInfo.slug);

    const storeTreeEligible = isTenantTreeEligible(
      slugInfo.rewrittenPath,
      isPreviewIframe,
      slugInfo.slug
    );
    const url = storeTreeEligible
      ? buildStoreTreeUrl(request, `slug:${slugInfo.slug}`, slugInfo.rewrittenPath)
      : request.nextUrl.clone();
    if (!storeTreeEligible) {
      url.pathname = slugInfo.rewrittenPath;
    }

    const response = NextResponse.rewrite(url, { request: { headers: requestHeaders } });

    // Only write the cookie when missing or stale. Re-setting it on every request
    // forces `Cache-Control: no-store`, which hurts storefront crawl budget.
    if (request.cookies.get('x-store-slug')?.value !== slugInfo.slug) {
      // maxAge (30d) is REQUIRED. As a session cookie this dies on browser close,
      // so a next-day refresh of a bare deep route on a platform host has neither
      // slug nor cookie and falls back to the demo store — "Unable to resolve
      // store context" (CF-migration regression, fixed 2026-06-27).
      response.cookies.set('x-store-slug', slugInfo.slug, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        // S3-3 (2026-09-22 security audit): explicit Secure in production.
        // Gated on NODE_ENV (not unconditional) so local dev over plain
        // http keeps working — same pattern as AUTH_COOKIE_OPTIONS in
        // apps/api/src/routes/auth.routes.ts.
        secure: process.env.NODE_ENV === 'production',
        maxAge: 60 * 60 * 24 * 30,
      });
    }
    return response;
  }

  // Bare platform root — clear any sticky store cookie so visitors aren't trapped
  // on the last store they looked at.
  if (request.nextUrl.pathname === '/') {
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    if (request.cookies.get('x-store-slug')) {
      response.cookies.delete('x-store-slug');
    }
    return response;
  }

  // Subroute with no slug in the URL — carry store context from the cookie
  // (e.g. /products or /cart after /palora). NOT for the agent/feed documents
  // (#1959): they answer `public, s-maxage=…`, and Cloudflare's cache key
  // ignores Vary/Cookie, so a cookie-resolved store's document would be cached
  // under the bare platform URL and served to every other visitor. Those paths
  // resolve ONLY from the URL slug (`/<slug>/llms.txt`) or the custom-domain
  // Host — the platform root answers as the platform (404 for ACP/UCP/feed).
  const cookieSlug = isUrlKeyedPublicPath(request.nextUrl.pathname)
    ? undefined
    : request.cookies.get('x-store-slug')?.value;
  if (cookieSlug) {
    requestHeaders.set('x-store-slug', cookieSlug);
    // Signal-only header (nothing routes on it): the agent-discovery routes
    // (llms.txt, .well-known/acp.json, .well-known/ucp) need to tell "the
    // slug came from the URL" apart from "the slug came from this cookie
    // fallback" so they can mark a cookie-resolved response non-shared-
    // cacheable — the same request line can otherwise answer with a
    // different store depending on which visitor's cookie it carried
    // (scoped-audit P2 on PR #1942).
    requestHeaders.set('x-store-slug-source', 'cookie');

    if (isTenantTreeEligible(request.nextUrl.pathname, isPreviewIframe, cookieSlug)) {
      const storeTreeUrl = buildStoreTreeUrl(
        request,
        `slug:${cookieSlug}`,
        request.nextUrl.pathname
      );
      return NextResponse.rewrite(storeTreeUrl, { request: { headers: requestHeaders } });
    }
  }

  return NextResponse.next({ request: { headers: requestHeaders } });
}

/**
 * Store-specific documents that are SHARED-cacheable (`public, s-maxage`) and
 * therefore must be keyed by URL/Host alone — never by the sticky
 * `x-store-slug` cookie, which no cache in front of us keys on (#1959).
 */
const URL_KEYED_PUBLIC_PATHS = [
  '/llms.txt',
  '/.well-known/acp.json',
  '/.well-known/ucp',
  '/feeds/products.json',
];

/** Exact match OR anything beneath it (`/.well-known/ucp/<doc>`). */
function isUrlKeyedPublicPath(pathname: string): boolean {
  return URL_KEYED_PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(`${p}/`));
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
 * the URL, the sticky cookie or the preview params — never from the client.
 */
export const MIDDLEWARE_ASSERTED_HEADERS = [
  'x-is-platform',
  'x-store-slug',
  'x-store-slug-source',
  'x-store-domain',
  'x-store-identifier',
  'x-preview-draft',
  'x-original-host',
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

  // www → apex canonical 301 for CUSTOM store domains only. Platform www hosts
  // (www.forcemediakw.com / www.force-ai.co) are real platform hosts and are
  // skipped via isPlatformDomain. The www custom hostname is enrolled in
  // Cloudflare-for-SaaS (CloudflareDomainService.addDomain) so TLS terminates
  // before we reach here; we then send visitors to the single canonical apex.
  const bareHost = hostname.split(':')[0].toLowerCase();
  if (bareHost.startsWith('www.') && !isPlatformDomain(hostname)) {
    const apexUrl = new URL(
      request.nextUrl.pathname + request.nextUrl.search,
      `https://${bareHost.replace(/^www\./, '')}`
    );
    return NextResponse.redirect(apexUrl, 301);
  }

  const draftToken = request.nextUrl.searchParams.get('_layoutDraft');
  const isPreviewIframe = request.nextUrl.searchParams.has('_preview');
  const withDraftCookie = applyDraftCookie(request, draftToken, isPreviewIframe);

  const requestHeaders = new Headers(request.headers);
  for (const name of MIDDLEWARE_ASSERTED_HEADERS) requestHeaders.delete(name);
  requestHeaders.set('x-original-host', hostname);
  propagateDraftHeader(requestHeaders, request, draftToken, isPreviewIframe);

  // Bare root on `store.forcemediakw.com` deliberately does NOT redirect to
  // forcemediakw.com: the homepage serves the Force Store Builder landing page
  // (apps/web/src/components/PlatformLanding.tsx) and unknown slugs render the
  // same component via app/not-found.tsx. The old redirect was lossy — visitors
  // learning about the store builder were dumped on a site pitching another service.
  const storeIdentifier = getStoreIdentifier(hostname);

  return withDraftCookie(
    storeIdentifier
      ? handleCustomDomain(request, storeIdentifier, requestHeaders, isPreviewIframe)
      : handlePlatformDomain(request, requestHeaders, isPreviewIframe)
  );
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
     * the platform's "Force" manifest — verified live on pecannbee.com.kw
     * 2026-10-01. It must see the same store context every page gets.
     *
     * favicon.ico is intentionally NOT excluded here (removed 2026-07-02) so
     * custom-domain stores can get a per-store favicon (see the
     * `x-store-domain` branch above). This does NOT change platform-domain
     * (store.force-ai.co etc) behavior: getStoreIdentifier() returns null for
     * platform hosts, so those requests fall through this middleware to
     * NextResponse.next() with no rewrite, and Next serves the static
     * /public/favicon.ico exactly as before.
     */
    '/((?!_next/static|_next/image|sw\\.js|api/|public/|\\.well-known/security\\.txt).*)',
  ],
};
