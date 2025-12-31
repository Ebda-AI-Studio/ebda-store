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
  } else {
    // This is a platform domain - could be demo store or main site
    requestHeaders.set('x-is-platform', 'true');
  }

  // Create response with modified headers
  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  // Also set response headers for client-side access
  if (storeIdentifier) {
    response.headers.set('x-store-domain', storeIdentifier);
  }

  return response;
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
