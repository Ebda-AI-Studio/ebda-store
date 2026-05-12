import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Platform hostnames — exact match only.
 * These are the platform's marketing/admin/app domains. Any OTHER subdomain
 * of forcemediakw.com (e.g. shop.forcemediakw.com) is a CUSTOM STORE domain
 * that store owners can configure.
 */
const PLATFORM_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  'forcemediakw.com',
  'www.forcemediakw.com',
  'admin.forcemediakw.com',
  'app.forcemediakw.com',
  'store.forcemediakw.com',
]);

/**
 * Hosting provider suffixes — any subdomain is platform (preview deploys, tunnels).
 * These are used for development/staging only. Production custom domains never
 * end with these suffixes.
 */
const PLATFORM_SUFFIXES = ['vercel.app', 'netlify.app', 'ngrok.io', 'ngrok-free.app'];

/**
 * Check if a hostname is a platform domain (not a custom store domain)
 */
function isPlatformDomain(hostname: string): boolean {
  // Remove port if present, normalize to lowercase
  const host = hostname.split(':')[0].toLowerCase();

  if (PLATFORM_HOSTS.has(host)) return true;
  return PLATFORM_SUFFIXES.some(suffix => host.endsWith(`.${suffix}`));
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
  const storeIdentifier = getStoreIdentifier(hostname);

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

  if (storeIdentifier) {
    // This is a custom domain - set store identification headers
    requestHeaders.set('x-store-domain', storeIdentifier);
    requestHeaders.set('x-store-identifier', storeIdentifier);

    // Create response with modified headers
    const response = NextResponse.next({
      request: { headers: requestHeaders },
    });
    response.headers.set('x-store-domain', storeIdentifier);
    return response;
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
      response.cookies.set('x-store-slug', slugInfo.slug, { path: '/', httpOnly: true });
    }
    return response;
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
    return response;
  }

  // Subroute on platform domain (no slug in URL) — use cookie to maintain
  // store context across navigation (e.g. /products, /cart after /palora).
  const cookieSlug = request.cookies.get('x-store-slug')?.value;
  if (cookieSlug) {
    requestHeaders.set('x-store-slug', cookieSlug);
  }

  return NextResponse.next({
    request: { headers: requestHeaders },
  });
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
     * - favicon.ico (favicon file)
     * - public folder
     * - api routes (handled separately)
     */
    '/((?!_next/static|_next/image|favicon\\.ico|manifest\\.webmanifest|sw\\.js|api/|public/).*)',
  ],
};
