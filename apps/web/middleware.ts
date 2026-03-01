import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Platform domains that should NOT be treated as custom store domains
 * These are used for the main platform, admin, and development
 */
const PLATFORM_DOMAINS = [
  'localhost',
  '127.0.0.1',
  'forcemediakw.com',
  'www.forcemediakw.com',
  'admin.forcemediakw.com',
  'app.forcemediakw.com',
  'vercel.app',
  'netlify.app',
  'ngrok.io',
  'ngrok-free.app',
];

/**
 * Check if a hostname is a platform domain (not a custom store domain)
 */
function isPlatformDomain(hostname: string): boolean {
  // Remove port if present
  const host = hostname.split(':')[0];

  return PLATFORM_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`));
}

/**
 * Extract the store identifier from a custom domain
 * For custom domains, the entire domain is the identifier
 */
function getStoreIdentifier(hostname: string): string | null {
  const host = hostname.split(':')[0];

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
  'returns',
  'shipping',
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

  // The first segment is a potential store slug
  const remainingSegments = segments.slice(1);
  const rewrittenPath = '/' + remainingSegments.join('/') || '/';

  return { slug: firstSegment, rewrittenPath };
}

export function middleware(request: NextRequest) {
  const hostname = request.headers.get('host') || '';
  const storeIdentifier = getStoreIdentifier(hostname);

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
    // Persist store slug in cookie so subsequent pages (e.g. /products) keep store context
    response.cookies.set('x-store-slug', slugInfo.slug, { path: '/', httpOnly: false });
    return response;
  }

  // No slug — check cookie for persisted store slug
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
    '/((?!_next/static|_next/image|favicon.ico|api/|public/).*)',
  ],
};
