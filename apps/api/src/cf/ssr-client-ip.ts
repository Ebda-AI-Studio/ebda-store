/**
 * Ruling RL-SSR-IP-6: the shopper address a storefront server render forwards, and when it is believed.
 *
 * The storefront Worker (`ebda-web`) fetches this API while it renders a page, from its own egress address.
 * It forwards the shopper's `cf-connecting-ip` as `x-ebda-client-ip`, signed in `x-ebda-ssr-auth` with
 * hex(HMAC-SHA256(key = REVALIDATE_SECRET, msg = "ebda-ssr-client-ip.v1\n" + address)) (apps/web/ssr-client-address.ts).
 *
 * Here, before Express sees anything:
 *  - both headers are ALWAYS removed;
 *  - the address is honoured only when the signature verifies (constant time), the value is an IP literal,
 *    and the request is a GET/HEAD of one of the anonymous storefront reads in `SSR_FORWARD_ROUTES`;
 *  - X-Forwarded-For is then that address (else `cf-connecting-ip`, else it is DELETED, so a caller can never
 *    type the address `trust proxy` reads).
 * No REVALIDATE_SECRET on the API: nothing is ever believed, and the isolate says so once, loudly.
 */
import { isIP } from '../lib/safe-fetch';

export const CLIENT_IP_HEADER = 'x-ebda-client-ip';
export const SSR_AUTH_HEADER = 'x-ebda-ssr-auth';
/**
 * Set by the storefront's same-origin `/api/v1` proxy (apps/web/src/app/api/v1/[...path]/route.ts) on a BROWSER request it relays
 * (sign-in, refresh, cart, account...). It widens the signed-address rule from the anonymous-read list to any route: without it
 * every shopper's login would share the storefront Worker's egress bucket (the IP-wide auth failure limiter would lock the platform).
 * Only meaningful together with a valid signature; always stripped from the request that reaches Express.
 */
export const PROXY_HOP_HEADER = 'x-ebda-proxy-hop';
/** Signed by the storefront for a render with no shopper behind it (background revalidation): no per-address bucket. */
export const NO_SHOPPER_ADDRESS = 'none';
/**
 * Set by this module (never by a caller: an inbound copy is always removed) when a request has NO client address.
 * Express has no socket address on workerd and would otherwise fall back to one fixed value for every such request;
 * app.ts reads this marker and leaves `req.ip` empty, so the per-address limiters skip it (`noClientIp`).
 */
export const NO_CLIENT_ADDRESS_HEADER = 'x-ebda-no-client-address';
const SIGNING_CONTEXT = 'ebda-ssr-client-ip.v1\n';
const PUBLIC_PREFIX = '/api/v1/public';

/**
 * Every GET route of the two storefront render routers (`routes/public.routes.ts`, `routes/public-store-layout.routes.ts`,
 * both mounted at /api/v1/public), classified. `forward` = an anonymous read the storefront makes while rendering, charged
 * to the shopper. `own` = the caller's own address is kept (signed-in, per-person, browser-only or preview-token routes).
 * `tests/unit/ssr-client-ip.test.ts` fails when a GET route in either file is missing here.
 */
export const SSR_FORWARD_ROUTES: Readonly<Record<string, 'forward' | 'own'>> = {
  '/health': 'own',
  '/products': 'forward',
  '/products/:slugOrId': 'forward',
  '/size-charts': 'forward',
  '/feed/products.json': 'forward',
  '/categories': 'forward',
  '/tags': 'forward',
  '/redirects/resolve': 'forward',
  '/qr/scan': 'forward',
  '/stores': 'forward',
  '/stores/:slugOrId': 'forward',
  '/store/resolve': 'forward',
  '/stores/:storeId/layout': 'forward',
  '/stores/:storeId/pages/:kind': 'forward',
  '/stores/:storeId/testimonials': 'forward',
  '/stores/:storeId/builder-preview': 'own',
  '/cart': 'own',
  '/cart/whatsapp-optin': 'own',
  '/customers/me/reorder': 'own',
  '/orders': 'own',
  // The guest order-status page (/o/<token>) renders it server-side: charged to the shopper's own address, one bucket each (Ruling WA-COD-V2-2).
  '/order-status/:token': 'forward',
  '/orders/:id': 'own',
  '/orders/:id/invoice': 'own',
  '/:storeId/search/suggest': 'own',
  '/:storeId/wishlist/:userId': 'own',
  '/reviews/can-submit': 'own',
};

function routeRegex(route: string): RegExp {
  const body = route
    .split('/')
    .map(seg => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${PUBLIC_PREFIX.replace(/\//g, '\\/')}${body}\\/?$`);
}

const FORWARD_PATTERNS = Object.entries(SSR_FORWARD_ROUTES)
  .filter(([, kind]) => kind === 'forward')
  .map(([route]) => routeRegex(route));

/** A GET/HEAD of an anonymous storefront read: the only requests a forwarded address may be honoured on. */
export function isForwardableRead(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return false;
  return FORWARD_PATTERNS.some(re => re.test(pathname));
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Constant-time check of the storefront's signature (WebCrypto `verify` compares in constant time). */
export async function verifyClientIpSignature(
  secret: string,
  ip: string,
  auth: string
): Promise<boolean> {
  const mac = hexToBytes(auth);
  if (!mac) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  return crypto.subtle.verify('HMAC', key, mac, enc.encode(SIGNING_CONTEXT + ip));
}

let warnedNoSecret = false;

/**
 * True exactly once per isolate when REVALIDATE_SECRET is missing: the caller logs it (worker.ts, a literal message),
 * because without it every storefront render shares the storefront Worker's bucket again.
 */
export function shouldWarnNoSecret(secret: unknown): boolean {
  if (warnedNoSecret || (typeof secret === 'string' && secret.length > 0)) return false;
  warnedNoSecret = true;
  return true;
}

export interface ClientAddress {
  /** The request with both forward headers removed and X-Forwarded-For set to `ip` (or deleted). */
  request: Request;
  /** The address every per-IP limiter must key on, or null when there is none. */
  ip: string | null;
  /** True when the address came from a verified storefront forward. */
  forwarded: boolean;
}

/** Strip, verify and apply. Never throws; any doubt falls back to the address Cloudflare saw. */
export async function resolveClientAddress(
  incoming: Request,
  secret: unknown
): Promise<ClientAddress> {
  const claimed = incoming.headers.get(CLIENT_IP_HEADER)?.trim() ?? '';
  const auth = incoming.headers.get(SSR_AUTH_HEADER)?.trim() ?? '';
  const seen = incoming.headers.get('cf-connecting-ip')?.trim() || null;
  const headers = new Headers(incoming.headers);
  headers.delete(CLIENT_IP_HEADER);
  headers.delete(SSR_AUTH_HEADER);
  headers.delete(NO_CLIENT_ADDRESS_HEADER);
  headers.delete(PROXY_HOP_HEADER);
  const proxied = incoming.headers.get(PROXY_HOP_HEADER) === '1';

  let ip = seen;
  let forwarded = false;
  if (
    claimed &&
    auth &&
    typeof secret === 'string' &&
    secret.length > 0 &&
    (isIP(claimed) !== 0 || claimed === NO_SHOPPER_ADDRESS) &&
    (proxied || isForwardableRead(incoming.method, new URL(incoming.url).pathname))
  ) {
    try {
      if (await verifyClientIpSignature(secret, claimed, auth)) {
        // `none`: the storefront itself, no shopper. No address = the per-IP limiters skip it (`noClientIp`), the
        // per-store limits still apply. Never the storefront Worker's egress address, which every store would share.
        ip = claimed === NO_SHOPPER_ADDRESS ? null : claimed;
        forwarded = true;
      }
    } catch {
      // a WebCrypto failure is a "no": the address Cloudflare saw stands
    }
  }
  const hadInternal =
    incoming.headers.has(CLIENT_IP_HEADER) ||
    incoming.headers.has(SSR_AUTH_HEADER) ||
    incoming.headers.has(PROXY_HOP_HEADER) ||
    incoming.headers.has(NO_CLIENT_ADDRESS_HEADER);
  if (ip && !hadInternal && incoming.headers.get('x-forwarded-for') === ip) {
    return { request: incoming, ip, forwarded };
  }
  if (ip) {
    headers.set('x-forwarded-for', ip);
  } else {
    headers.delete('x-forwarded-for');
    headers.set(NO_CLIENT_ADDRESS_HEADER, '1');
  }
  return { request: new Request(incoming, { headers }), ip, forwarded };
}

/** Test only. */
export function __resetSsrClientIpForTests(): void {
  warnedNoSecret = false;
}
