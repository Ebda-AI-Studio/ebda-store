/**
 * Same-origin API proxy: the ONLY way the storefront browser talks to the API (STORE-QA-119).
 *
 * Shopper sessions are cookies. Set by api.ebda.app they are third-party on a merchant custom domain and
 * Safari drops them (the shopper "keeps getting logged out" on the account page). Relayed through here they
 * are host-only first-party cookies on whatever host served the page, on every host type, in every browser.
 * Rewriting rules live in lib/auth-proxy.ts. Merchant/admin auth does not use this route.
 */
import {
  buildDownstreamHeaders,
  buildUpstreamHeaders,
  appendRewrittenCookies,
} from '@/lib/auth-proxy';
import { UPSTREAM_API_URL } from '@/lib/api';

export const dynamic = 'force-dynamic';

async function relay(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const url = new URL(request.url);
  const host = request.headers.get('host') ?? url.host;
  const storefrontOrigin = `${url.protocol}//${host}`;
  const secure = url.protocol === 'https:';

  const target = `${UPSTREAM_API_URL}/${path.map(encodeURIComponent).join('/')}${url.search}`;
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: buildUpstreamHeaders(request.headers, storefrontOrigin),
      body: hasBody ? request.body : undefined,
      // @ts-expect-error duplex is required by undici/workerd for a streamed body and missing from lib.dom
      duplex: hasBody ? 'half' : undefined,
      // A 3xx is relayed to the browser, never followed server-side (the signed address must not follow it).
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch {
    return Response.json(
      { success: false, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Service unavailable' } },
      { status: 502, headers: { 'cache-control': 'no-store' } }
    );
  }

  const headers = buildDownstreamHeaders(upstream.headers);
  appendRewrittenCookies(headers, upstream.headers, secure);
  return new Response(upstream.body, { status: upstream.status, headers });
}

export const GET = relay;
export const POST = relay;
export const PUT = relay;
export const PATCH = relay;
export const DELETE = relay;
export const HEAD = relay;
