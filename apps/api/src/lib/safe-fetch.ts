/**
 * SSRF-safe fetch for MERCHANT-SUPPLIED URLs (product image URLs, store logo
 * URLs). A merchant can set these to anything, so a naive `fetch(url)` on the
 * server lets them probe internal services / cloud metadata (169.254.169.254)
 * and have the response described back to them via Gemini. This guard:
 *   1. requires an http(s) URL,
 *   2. resolves the host and blocks if ANY resolved address is loopback,
 *      private, link-local (cloud metadata), CGNAT, or unspecified,
 *   3. follows redirects MANUALLY, re-validating every hop.
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
    throw new Error('SSRF_BLOCKED: host does not resolve');
  }
  if (addrs.length === 0) throw new Error('SSRF_BLOCKED: host does not resolve');
  for (const { address } of addrs) {
    if (isBlockedIp(address)) throw new Error('SSRF_BLOCKED: host resolves to a private address');
  }
  return u;
}

/**
 * SSRF-safe image fetch. Validates the URL and every redirect target against
 * the private-range blocklist, following at most MAX_REDIRECTS manually.
 */
export async function safeFetchImage(rawUrl: string, init?: RequestInit): Promise<Response> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHttpUrl(current);
    const res = await fetch(current, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      current = new URL(loc, current).toString(); // resolve relative redirects
      continue;
    }
    return res;
  }
  throw new Error('SSRF_BLOCKED: too many redirects');
}
