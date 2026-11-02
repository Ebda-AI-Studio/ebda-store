import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { newCspNonce } from '@ebda/shared';
import { accountsOrigin, buildOrdersCsp } from './lib/csp';

/**
 * Orders PWA middleware: the per-request Content-Security-Policy nonce (SEC-4 / M-067). Mints a
 * nonce, hands it to Next on the REQUEST (`Content-Security-Policy` + `x-nonce`, which is how Next
 * stamps the nonce on its own scripts) and sets the matching policy on the RESPONSE. It does not
 * gate auth: the API validates the session on every call.
 */
export function middleware(request: NextRequest) {
  const nonce = newCspNonce();
  const csp = buildOrdersCsp(nonce, accountsOrigin(process.env.NEXT_PUBLIC_ACCOUNTS_URL));

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  // Pages and RSC payloads only: static assets, the service worker and the manifest need no nonce.
  matcher: [
    // Everything except Next internals and a few named static prefixes/files. NOT "anything with a
    // file extension": a dynamic route such as /foo.svg or /stores/a.b/settings must still get the
    // CSP. Static assets in public/ get a fallback from public/_headers.
    '/((?!_next/static|_next/image|icons/|favicon\\.(?:ico|png|svg)$|health$|sw\\.js$|manifest\\.webmanifest$|OneSignalSDK[\\w.]*\\.js$).*)',
  ],
};
