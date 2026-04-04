import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Admin middleware — gate to prevent serving admin HTML to unauthenticated visitors.
 *
 * The HTTP-only auth cookie is set on the API domain (cross-origin), so it is
 * NOT visible here. Instead we check for a `force-session` indicator cookie that
 * the client sets after a successful login. This is NOT a security token — the
 * real auth is the HTTP-only cookie validated by the API on every request.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths
  const publicPaths = ['/login', '/register', '/forgot-password', '/reset-password'];
  const isPublicPath = publicPaths.some(p => pathname.startsWith(p));

  if (isPublicPath) {
    return NextResponse.next();
  }

  // Check for session indicator cookie
  const hasSession = request.cookies.get('force-session');
  if (!hasSession) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.).*)'],
};
