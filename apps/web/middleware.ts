import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isPlatformHost } from '@/lib/platform-host';

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
]);

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

export function middleware(request: NextRequest) {
  const hostname = request.headers.get('host') || '';

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

  const storeIdentifier = getStoreIdentifier(hostname);

  // 2026-05-21: Preview-unsaved draft cookie propagation. When the admin
  // page-builder loads the storefront with ?_layoutDraft=<token>, that
  // query param only exists on the initial iframe load — Link clicks
  // inside the iframe drop it, and the root layout (server component)
  // can't read searchParams to reach the draft. Solution: stash the
  // token in a same-origin cookie at middleware time so root layout +
  // every page sees it consistently.
  //
  // 2026-05-28 LEAK FIX: The admin iframe ALWAYS includes a ?_preview=<tick>
  // param (see page-builder iframe src construction). Normal visitors NEVER
  // have ?_preview= in their URL. We gate draft-cookie propagation on this:
  //   - ?_preview= present  → admin preview iframe → set/refresh draft cookie
  //                           AND propagate it as x-preview-draft header.
  //   - ?_preview= absent   → normal visitor (or same-browser re-visit after
  //                           previewing) → CLEAR the draft cookie immediately.
  //
  // This prevents unsaved admin changes from leaking to real storefront visitors
  // who happen to open the store in the same browser used for admin previewing.
  // Cookie is SameSite=None + Secure so it survives cross-site iframe contexts
  // (admin.forcemediakw.com framing wadyaljuz.com). TTL = 1h matches Redis.
  const draftToken = request.nextUrl.searchParams.get('_layoutDraft');
  // _preview=<tick> is injected unconditionally by the admin page-builder iframe
  // URL (see apps/admin/.../page-builder/page.tsx line ~1667). Its presence
  // confirms we are inside an admin preview iframe, not a normal storefront visit.
  const isPreviewIframe = request.nextUrl.searchParams.has('_preview');

  const draftCookie = (response: NextResponse) => {
    if (draftToken && isPreviewIframe) {
      // Inside the admin iframe and the initial ?_layoutDraft= load — set cookie.
      response.cookies.set('force-preview-draft', draftToken, {
        path: '/',
        maxAge: 3600,
        sameSite: 'none',
        secure: true,
        httpOnly: true,
      });
    } else if (!isPreviewIframe) {
      // Normal visitor (no ?_preview=) — clear any stale draft cookie so unsaved
      // admin changes are never visible on the public storefront.
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

  // Bare root on `store.forcemediakw.com` no longer redirects to
  // forcemediakw.com — the homepage now serves a dedicated Force
  // Store Builder landing page (apps/web/src/components/PlatformLanding.tsx)
  // and unknown slugs render the same component as a 404 via
  // app/not-found.tsx. The redirect was lossy: customers learning
  // about the store-builder platform got dumped onto the parent
  // marketing site that pitches a different service.

  // Clone the request headers
  const requestHeaders = new Headers(request.headers);

  // Always set the original host header
  requestHeaders.set('x-original-host', hostname);

  // Propagate the draft token as a REQUEST header so server components in the
  // SAME request can read it (cookies set in the response aren't visible to
  // that response's server components). Only propagate when we are inside the
  // admin preview iframe (?_preview= guard) to prevent draft cookie from
  // affecting normal visitors who have a stale draft cookie in the same browser.
  if (draftToken && isPreviewIframe) {
    // First ?_layoutDraft= load inside the iframe — token is in the URL.
    requestHeaders.set('x-preview-draft', draftToken);
  } else if (isPreviewIframe) {
    // Subsequent navigation within the iframe (Link click drops ?_layoutDraft
    // from URL but ?_preview= stays). Read from cookie to keep draft active.
    const cookieDraft = request.cookies.get('force-preview-draft')?.value;
    if (cookieDraft) requestHeaders.set('x-preview-draft', cookieDraft);
  }
  // Else: normal visitor — no x-preview-draft header → layout.tsx serves committed layout.

  if (storeIdentifier) {
    // This is a custom domain - set store identification headers
    requestHeaders.set('x-store-domain', storeIdentifier);
    requestHeaders.set('x-store-identifier', storeIdentifier);

    // Custom-domain /favicon.ico → dynamic per-store favicon (falls back to
    // the neutral platform default when the store has none). This branch is
    // ONLY reachable when storeIdentifier is truthy, i.e. NEVER on a platform
    // host (store.force-ai.co etc — getStoreIdentifier returns null there),
    // so the shared-domain /favicon.ico keeps serving the static
    // /public/favicon.ico exactly as before this change. The `sf=1` marker is
    // set by the route handler's own fallback redirect so this doesn't loop.
    if (request.nextUrl.pathname === '/favicon.ico' && !request.nextUrl.searchParams.has('sf')) {
      const url = request.nextUrl.clone();
      url.pathname = '/api/store-favicon';
      const response = NextResponse.rewrite(url, {
        request: { headers: requestHeaders },
      });
      return draftCookie(response);
    }

    // Create response with modified headers
    const response = NextResponse.next({
      request: { headers: requestHeaders },
    });
    response.headers.set('x-store-domain', storeIdentifier);
    return draftCookie(response);
  }

  // Platform domain — check for store slug in URL path
  requestHeaders.set('x-is-platform', 'true');

  const slugInfo = extractStoreSlug(request.nextUrl.pathname);

  if (slugInfo) {
    // Set slug header and rewrite URL to strip the slug prefix
    requestHeaders.set('x-store-slug', slugInfo.slug);

    const url = request.nextUrl.clone();
    url.pathname = slugInfo.rewrittenPath;

    const response = NextResponse.rewrite(url, {
      request: { headers: requestHeaders },
    });
    // Only set the cookie when it's missing or stale. Re-setting it on every
    // request forces Next to mark the response uncacheable
    // (`Cache-Control: no-store`), which hurts crawl budget on the storefront.
    if (request.cookies.get('x-store-slug')?.value !== slugInfo.slug) {
      // maxAge (30d) is REQUIRED: without it this is a session cookie that
      // dies on browser close, so a next-day refresh of a bare deep route on
      // a platform host (e.g. store.force-ai.co/account) has no slug in the URL
      // AND no cookie → falls back to the demo store → "Unable to resolve store
      // context". Persisting it keeps server-side store resolution working
      // across restarts. (CF-migration regression, fixed 2026-06-27.)
      response.cookies.set('x-store-slug', slugInfo.slug, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 30,
      });
    }
    return draftCookie(response);
  }

  // Bare root on platform domain — reset to default. Clear any sticky
  // store cookie so users aren't trapped on the last store they visited.
  if (request.nextUrl.pathname === '/') {
    const response = NextResponse.next({
      request: { headers: requestHeaders },
    });
    if (request.cookies.get('x-store-slug')) {
      response.cookies.delete('x-store-slug');
    }
    return draftCookie(response);
  }

  // Subroute on platform domain (no slug in URL) — use cookie to maintain
  // store context across navigation (e.g. /products, /cart after /palora).
  const cookieSlug = request.cookies.get('x-store-slug')?.value;
  if (cookieSlug) {
    requestHeaders.set('x-store-slug', cookieSlug);
  }

  return draftCookie(
    NextResponse.next({
      request: { headers: requestHeaders },
    })
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
     * - manifest.webmanifest / sw.js
     * - public folder
     * - api routes (handled separately, EXCEPT /api/store-favicon which the
     *   favicon.ico rewrite below targets — matcher excludes `api/` broadly,
     *   but the rewrite target itself never re-enters this matcher since
     *   `/api/store-favicon` is excluded by the `api/` pattern, which is what
     *   we want: middleware runs once on `/favicon.ico`, not again on the
     *   rewritten destination)
     *
     * favicon.ico is intentionally NOT excluded here (removed 2026-07-02) so
     * custom-domain stores can get a per-store favicon (see the
     * `x-store-domain` branch above). This does NOT change platform-domain
     * (store.force-ai.co etc) behavior: getStoreIdentifier() returns null for
     * platform hosts, so those requests fall through this middleware to
     * NextResponse.next() with no rewrite, and Next serves the static
     * /public/favicon.ico exactly as before.
     */
    '/((?!_next/static|_next/image|manifest\\.webmanifest|sw\\.js|api/|public/).*)',
  ],
};
