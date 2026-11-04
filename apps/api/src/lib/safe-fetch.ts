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
import { isWorkers } from './runtime';
import { fetchWithTimeout } from './fetch-timeout';

const MAX_REDIRECTS = 3;

/**
 * 4 / 6 / 0 for an IPv4 literal, an IPv6 literal, or neither. `node:net`'s `isIP` semantics
 * without `node:net` (this module also runs on Workers, where `dns` / `net` are not the
 * way to reach a resolver, R-EBDA-001 section 5).
 */
function isIP(s: string): 0 | 4 | 6 {
  if (/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(s))
    return 4;
  if (s.includes(':') && /^[0-9a-fA-F:.]+$/.test(s)) {
    try {
      // The WHATWG URL parser validates and normalises IPv6 literals.
      return new URL(`http://[${s}]/`).hostname ? 6 : 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

/** Every address `host` resolves to. Node: the OS resolver. Workers: DNS over HTTPS. */
export type HostResolver = (host: string) => Promise<Array<{ address: string }>>;

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';

/** A (1) and AAAA (28) answers for a name, through Cloudflare's DoH JSON API. */
export async function resolveViaDoh(
  host: string,
  fetchImpl: typeof fetch = fetch
): Promise<Array<{ address: string }>> {
  const query = async (type: 'A' | 'AAAA'): Promise<string[]> => {
    const res = await fetchImpl(`${DOH_ENDPOINT}?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`DoH ${type} lookup answered ${res.status}`);
    const body = (await res.json()) as {
      Status?: number;
      Answer?: Array<{ type: number; data: string }>;
    };
    // Status 3 = NXDOMAIN: no addresses, not a failure. Anything else non-zero is a failed lookup.
    if (body.Status !== undefined && body.Status !== 0 && body.Status !== 3) {
      throw new Error(`DoH ${type} lookup status ${body.Status}`);
    }
    const want = type === 'A' ? 1 : 28;
    return (body.Answer ?? []).filter(a => a.type === want).map(a => a.data);
  };
  const [v4, v6] = await Promise.allSettled([query('A'), query('AAAA')]);
  // Both families failing is a failed lookup; one failing alone must NOT hide the other's
  // answers, and must not let an unchecked family through: it is reported as failed too.
  if (v4.status === 'rejected' || v6.status === 'rejected') {
    throw new Error('DoH lookup failed');
  }
  return [...v4.value, ...v6.value].map(address => ({ address }));
}

async function nodeLookup(host: string): Promise<Array<{ address: string }>> {
  const { promises: dns } = await import('node:dns');
  return dns.lookup(host, { all: true });
}

let resolver: HostResolver = isWorkers ? host => resolveViaDoh(host) : nodeLookup;

/** Test seam: replace the resolver (and get the previous one back). */
export function setHostResolver(next: HostResolver): HostResolver {
  const prev = resolver;
  resolver = next;
  return prev;
}

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
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['198.18.0.0', 15],
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
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
  // Canonicalise first (the WHATWG parser compresses and lower-cases), so an expanded or oddly
  // cased spelling of a blocked address cannot slip past the prefix checks below.
  let s = ip.toLowerCase();
  try {
    s = new URL(`http://[${s}]/`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return true; // not a parseable IPv6 literal: block
  }
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
  // ::/96 IPv4-compatible (::7f00:1 is 127.0.0.1), 100::/64 discard, 2001::/32 Teredo
  if (s.startsWith('::') || s.startsWith('100::') || /^2001:(0{1,4})?:/.test(s)) return true;
  // fec0::/10 site-local (deprecated, still routable on some networks), ff00::/8 multicast
  if (/^fe[c-f]/.test(s) || s.startsWith('ff')) return true;
  // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) embed an IPv4 address: block rather than decode.
  if (s.startsWith('64:ff9b:') || s.startsWith('2002:')) return true;
  // 2001:db8::/32 documentation range
  if (s.startsWith('2001:db8:')) return true;
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
    addrs = await resolver(host);
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
    const res = await fetchWithTimeout(current, { ...currentInit, redirect: 'manual' });
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
