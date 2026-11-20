/**
 * First-party API proxy helpers (STORE-QA-119).
 *
 * The shopper session used to be `SameSite=None` cookies set by api.ebda.app. On a merchant custom domain
 * (ameliaaurum.com) that is a THIRD-PARTY cookie: Safari/ITP drops it, so a shopper who signed in was
 * logged out the moment the account page asked "who am I". The browser now talks ONLY to its own origin
 * (`/api/v1/*`, the route handler in app/api/v1/[...path]/route.ts) and these helpers make the relay safe:
 *  - the cookies the API sets are re-issued HOST-ONLY (no Domain) and `SameSite=Lax`, so they are first-party
 *    on whichever host served the storefront (custom domain or <slug>.ebda.app);
 *  - only the two session cookies go upstream, and `Origin` is the storefront's own origin so the API's
 *    store-binding / CORS-TB / CSRF rules see the same caller they always did.
 */

/** The only cookies relayed to the API. */
export const SESSION_COOKIES = ['token', 'refresh_token'] as const;

/** Request headers never relayed (hop-by-hop, identity we set ourselves, or the platform's own signing headers). */
const BLOCKED_REQUEST_HEADERS = new Set([
  'host',
  'cookie',
  'origin',
  'referer',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'x-real-ip',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-store-domain',
  'x-store-slug',
  'x-ebda-client-ip',
  'x-ebda-ssr-auth',
  'x-ebda-proxy-hop',
  'x-ebda-no-client-address',
]);

/** Response headers never copied back: CORS belongs to the API's origin, cookies are rewritten, framing is ours. */
const BLOCKED_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-expose-headers',
  'access-control-max-age',
  'content-security-policy',
  'strict-transport-security',
  'cross-origin-resource-policy',
  'cross-origin-opener-policy',
  'x-frame-options',
]);

/** Keep exactly the session cookies out of a browser `Cookie` header. */
export function filterSessionCookies(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const kept = cookieHeader
    .split(';')
    .map(c => c.trim())
    .filter(c => SESSION_COOKIES.some(name => c.startsWith(`${name}=`)));
  return kept.length > 0 ? kept.join('; ') : null;
}

export function buildUpstreamHeaders(incoming: Headers, storefrontOrigin: string): Headers {
  const out = new Headers();
  incoming.forEach((value, key) => {
    const k = key.toLowerCase();
    if (BLOCKED_REQUEST_HEADERS.has(k) || k.startsWith('cf-') || k.startsWith('sec-')) return;
    out.set(key, value);
  });
  const cookie = filterSessionCookies(incoming.get('cookie'));
  if (cookie) out.set('cookie', cookie);
  out.set('origin', storefrontOrigin);
  // Widens the API's signed-client-address rule to this relayed browser request (apps/api/src/cf/ssr-client-ip.ts).
  out.set('x-ebda-proxy-hop', '1');
  return out;
}

export function buildDownstreamHeaders(upstream: Headers): Headers {
  const out = new Headers();
  upstream.forEach((value, key) => {
    if (!BLOCKED_RESPONSE_HEADERS.has(key.toLowerCase())) out.set(key, value);
  });
  // Session-bearing answers must never be shared by an edge/browser cache across shoppers.
  if (!out.has('cache-control')) out.set('cache-control', 'private, no-store');
  return out;
}

/**
 * Re-issue one upstream Set-Cookie as a first-party cookie: no Domain, SameSite=Lax, Secure on https.
 * Name, value, Path, Max-Age/Expires and HttpOnly are kept (so a deletion stays a deletion).
 */
export function rewriteSetCookie(raw: string, secure: boolean): string {
  const [pair, ...attrs] = raw.split(';').map(s => s.trim());
  const kept = attrs.filter(a => {
    const name = a.split('=')[0]!.toLowerCase();
    return name !== 'domain' && name !== 'samesite' && name !== 'secure' && name !== 'partitioned';
  });
  return [pair, ...kept, 'SameSite=Lax', ...(secure ? ['Secure'] : [])].join('; ');
}

export function appendRewrittenCookies(into: Headers, upstream: Headers, secure: boolean): void {
  for (const c of upstream.getSetCookie()) into.append('set-cookie', rewriteSetCookie(c, secure));
}
