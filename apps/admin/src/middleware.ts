import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Admin middleware — passthrough.
 *
 * Earlier versions of this file checked a `force-session` indicator cookie
 * and redirected to /login when missing. That breaks the iOS admin PWA:
 * Apple's ITP caps JS-set cookie lifetime to 7 days regardless of the
 * cookie's max-age, and Safari/WebKit also purges third-party cookies
 * (the API's auth cookie is third-party from this domain's POV). On a
 * phone PWA the indicator silently disappears and the user gets bounced
 * to /login on every reopen — even though their Bearer token in
 * localStorage is still perfectly valid.
 *
 * Auth is enforced where it actually matters:
 *   1. The API validates the JWT (cookie OR `Authorization: Bearer`) on
 *      every request via apps/api/src/middleware/auth.ts.
 *   2. The client-side AuthProvider (apps/admin/src/lib/auth.tsx)
 *      redirects to /login when /auth/me + /auth/refresh both fail.
 *
 * The middleware's only job here is to be lean enough that PWA users
 * stay logged in across iOS WebKit's storage purges.
 */
export function middleware(_request: NextRequest) {
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.).*)'],
};
