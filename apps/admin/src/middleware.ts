import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { newCspNonce } from '@ebda/shared';
import { accountsOrigin, adminApiOrigin, buildAdminCsp } from './lib/csp';

/**
 * Admin middleware: the per-request Content-Security-Policy nonce (SEC-4 / M-067).
 *
 * Earlier versions of this file checked an `ebda-session` indicator cookie and redirected to
 * /login when missing. That breaks the iOS admin PWA (Apple's ITP caps JS-set cookie lifetime and
 * purges third-party cookies), so it still does NOT gate auth:
 *   1. The API validates the JWT (cookie OR `Authorization: Bearer`) on every request.
 *   2. The client-side AuthProvider redirects to /login when /auth/me + /auth/refresh both fail.
 *
 * What it does now: mints a nonce, hands it to Next on the REQUEST (`Content-Security-Policy` +
 * `x-nonce`, which is how Next stamps the nonce on its own inline/bootstrap scripts and which the
 * root layout reads for its theme script) and sets the matching policy on the RESPONSE.
 */
export function middleware(request: NextRequest) {
  const nonce = newCspNonce();
  const csp = buildAdminCsp({
    nonce,
    pathname: request.nextUrl.pathname,
    apiOrigin: adminApiOrigin(process.env.NEXT_PUBLIC_API_URL),
    accountsOrigin: accountsOrigin(process.env.NEXT_PUBLIC_ACCOUNTS_URL),
    defaultFrameSrc: process.env.ADMIN_DEFAULT_FRAME_SRC,
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    // Everything except Next internals and a few named static prefixes/files. NOT "anything with a
    // file extension": a dynamic route such as /foo.svg or /stores/a.b/settings must still get the
    // CSP. Static assets in public/ get a fallback from public/_headers.
    '/((?!_next/static|_next/image|icons/|favicon\\.(?:ico|png|svg)$|health$|sw\\.js$|manifest\\.webmanifest$).*)',
  ],
};
