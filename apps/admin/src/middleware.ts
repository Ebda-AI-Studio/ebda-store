import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Server-side route protection for the admin app.
 *
 * Checks for the HTTP-only `token` cookie set by the API on login/register.
 * If the cookie is absent on a protected route the user is redirected to the
 * login page.  If the cookie is present on an auth page (login/register) the
 * user is redirected to the dashboard.
 *
 * NOTE: This middleware only checks for the *presence* of the cookie -- it
 * does not validate the JWT.  Full server-side JWT validation can be added
 * once the API secret is shared with the admin app or a dedicated verification
 * endpoint is available.
 */
export function middleware(request: NextRequest) {
  const token = request.cookies.get('token')?.value;
  const { pathname } = request.nextUrl;

  // Static assets and Next.js internals -- always allow
  const isPublicPath =
    pathname.startsWith('/_next/') || pathname.startsWith('/api/') || pathname === '/favicon.ico';

  if (isPublicPath) {
    return NextResponse.next();
  }

  // Auth pages that should be accessible without a token
  const isAuthPage = pathname.startsWith('/auth/');

  // No token on a protected route -- redirect to login
  if (!token && !isAuthPage) {
    const loginUrl = new URL('/auth/login', request.url);
    return NextResponse.redirect(loginUrl);
  }

  // Has token on an auth page -- redirect to dashboard
  if (token && isAuthPage) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
