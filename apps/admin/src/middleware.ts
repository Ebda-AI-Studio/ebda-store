import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Minimal middleware for the admin app.
 *
 * Auth protection is handled client-side by the AuthProvider which checks
 * the session via the API and redirects to /login when unauthenticated.
 *
 * The HTTP-only auth cookie is set on the API domain (cross-origin), so
 * it is NOT visible to this Next.js middleware running on the admin domain.
 * Server-side route protection can be added once the API and admin share a
 * domain or a same-site token mechanism is implemented.
 */
export function middleware(_request: NextRequest) {
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
