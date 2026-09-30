/**
 * SSRF-safe fetch for MERCHANT-SUPPLIED URLs (product image URLs, store logo
 * URLs, carrier API base URLs). A merchant can set these to anything, so a
 * naive `fetch(url)` on the server lets them probe internal services / cloud
 * metadata (169.254.169.254) and have the response described back to them via
 * Gemini or a carrier "test connection" result. This guard:
 *   1. requires an http(s) URL,
 *   2. resolves the host and blocks if ANY resolved address is loopback,
 *      private, link-local (cloud metadata), CGNAT, or unspecified,
 *   3. follows redirects MANUALLY, re-validating every hop.
 *
 * Step 3 is the half a pre-flight `assertPublicHttpUrl` cannot cover: `fetch`
 * defaults to `redirect: 'follow'`, so a host that resolves publicly at check
 * time can answer `302 Location: http://169.254.169.254/…` and undici walks
 * there for us. Validating the first URL and then handing it to a bare
 * `fetch()` leaves the oracle fully open — always call through `safeFetch`.
 *
 * Residual: classic DNS-rebinding (resolve public at check, private at connect)
 * is not fully closed — that needs a custom lookup-pinning agent, which breaks
 * TLS SNI for the https CDN URLs these are in practice. Resolve-and-block is the
 * proportionate, standard mitigation for the merchant-URL threat model.
 */
import { promises as dns } from 'dns';
import { isIP } from 'net';

const MAX_REDIRECTS = 3;

// IPv4 ranges that must never be reachable from a server-side fetch:
// unspecified, private (RFC1918), CGNAT, loopback, link-local (metadata!),
// IETF protocol assignments, benchmarking, multicast, reserved.
const V4_BLOCKS: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function v4ToInt(ip: string): number {
  return (
    ip.split('.').reduce((acc, oct) => ((acc << 8) + (parseInt(oct, 10) & 0xff)) >>> 0, 0) >>> 0
  );
}

function isBlockedV4(ip: string): boolean {
  const val = v4ToInt(ip);
  return V4_BLOCKS.some(([net, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (val & mask) === (v4ToInt(net) & mask);
  });
}

function isBlockedV6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === '::' || s === '::1') return true; // unspecified, loopback
  // IPv4-mapped, dotted form (::ffff:127.0.0.1)
  const dotted = s.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return isBlockedV4(dotted[1]);
  // IPv4-mapped, hex form (URL parsers normalize ::ffff:127.0.0.1 → ::ffff:7f00:1)
  const hex = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isBlockedV4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
  }
  // fe80::/10 link-local
  if (/^fe[89ab]/.test(s)) return true;
  // fc00::/7 unique-local
  if (s.startsWith('fc') || s.startsWith('fd')) return true;
  return false;
}

function isBlockedIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isBlockedV4(ip);
  if (fam === 6) return isBlockedV6(ip);
  return true; // not parseable as an IP → block
}

/**
 * Resolve + validate a merchant-supplied URL. Throws `SSRF_BLOCKED: <reason>`
 * if it isn't a public http(s) URL. Returns the parsed URL on success.
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('SSRF_BLOCKED: malformed URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`SSRF_BLOCKED: disallowed protocol ${u.protocol}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  if (isIP(host)) {
    if (isBlockedIp(host)) throw new Error('SSRF_BLOCKED: private/loopback IP literal');
    return u;
  }

  let addrs: Array<{ address: string }>;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    // The lookup itself failed (NXDOMAIN, resolver timeout/unreachable) —
    // distinct from a lookup that SUCCEEDED with zero records, which used to
    // share this exact message and made the two indistinguishable from a
    // carrier-connectivity log line ("is this DNS being flaky, or is the
    // configured host simply wrong").
    throw new Error('SSRF_BLOCKED: DNS_UNRESOLVED: host lookup failed');
  }
  if (addrs.length === 0) {
    throw new Error('SSRF_BLOCKED: DNS_UNRESOLVED: host resolved to no addresses');
  }
  for (const { address } of addrs) {
    if (isBlockedIp(address)) throw new Error('SSRF_BLOCKED: host resolves to a private address');
  }
  return u;
}

// Headers that must not travel to a host the ORIGINAL target chose for us.
// `redirect: 'follow'` strips these on a cross-origin hop; following redirects
// by hand means we have to, or a merchant's carrier API key is handed to
// whatever host their `baseUrl` redirects to.
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

/**
 * Re-shape the request for a redirect hop, mirroring what `fetch` does for us
 * on the `redirect: 'follow'` path: credentials are dropped when the origin
 * changes, and 301/302/303 downgrade the method to GET without a body (so a
 * shipment payload is never re-POSTed to a redirect target).
 */
function initForHop(init: RequestInit | undefined, status: number, sameOrigin: boolean) {
  const next: RequestInit = { ...init };

  if (!sameOrigin) {
    const headers = new Headers(init?.headers ?? {});
    for (const name of CREDENTIAL_HEADERS) headers.delete(name);
    next.headers = headers;
  }

  if (status === 301 || status === 302 || status === 303) {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      next.method = 'GET';
      delete next.body;
    }
  }

  return next;
}

/**
 * SSRF-safe fetch for a merchant-supplied URL. Validates the URL and every
 * redirect target against the private-range blocklist, following at most
 * MAX_REDIRECTS manually — a redirect to a blocked address throws
 * `SSRF_BLOCKED` instead of being followed.
 */
export async function safeFetch(rawUrl: string, init?: RequestInit): Promise<Response> {
  let current = rawUrl;
  let currentInit = init;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const validated = await assertPublicHttpUrl(current);
    const res = await fetch(current, { ...currentInit, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      const next = new URL(loc, current); // resolve relative redirects
      currentInit = initForHop(currentInit, res.status, next.origin === validated.origin);
      current = next.toString();
      // This hop's response is discarded — only the LAST response in the
      // chain is ever returned to the caller. Leaving an intermediate body
      // unconsumed holds its underlying connection open until GC, one leak
      // per redirect hop (audit-followup #1713). Applies to every hop,
      // including the one right before the "too many redirects" throw below
      // — that response also goes through this branch first.
      await res.body?.cancel().catch(() => {});
      continue;
    }
    return res;
  }
  throw new Error('SSRF_BLOCKED: too many redirects');
}

/** SSRF-safe image fetch. Thin alias kept for the image/logo call sites. */
export function safeFetchImage(rawUrl: string, init?: RequestInit): Promise<Response> {
  return safeFetch(rawUrl, init);
}
