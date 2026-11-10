/**
 * Ruling RL-SSR-IP-6: a server render is charged to the shopper, not to this Worker.
 *
 * The API limits anonymous public reads per client address. Server-side fetches leave this Worker with
 * the Worker's own egress address, so without this every shopper's render shared one bucket. Here the
 * incoming request's `cf-connecting-ip` is held in AsyncLocalStorage for the life of the request, and
 * ONE `globalThis.fetch` wrapper (installed once per isolate) adds two headers to requests whose origin
 * is the API origin, and to nothing else:
 *   x-ebda-client-ip: <address>
 *   x-ebda-ssr-auth:  hex(HMAC-SHA256(key = REVALIDATE_SECRET, msg = "ebda-ssr-client-ip.v1\n" + address))
 * The API honours the address only when the signature verifies, and only on its storefront read list
 * (apps/api/src/cf/ssr-client-ip.ts). No address or no secret: neither header (the old behaviour).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const CLIENT_IP_HEADER = 'x-ebda-client-ip';
export const SSR_AUTH_HEADER = 'x-ebda-ssr-auth';
const SIGNING_CONTEXT = 'ebda-ssr-client-ip.v1\n';
/** next/dist/server/lib/patch-fetch-symbol.js */
const NEXT_PATCH_SYMBOL = Symbol.for('next-patch');

interface Forward {
  ip: string;
  auth: string;
}

const store = new AsyncLocalStorage<Forward | null>();

export async function signClientIp(secret: string, ip: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, enc.encode(SIGNING_CONTEXT + ip))
  );
  return Array.from(mac, b => b.toString(16).padStart(2, '0')).join('');
}

function originOf(input: RequestInfo | URL): string | null {
  try {
    if (typeof input === 'string') return new URL(input).origin;
    if (input instanceof URL) return input.origin;
    return new URL(input.url).origin;
  } catch {
    return null;
  }
}

let installedFor: string | null = null;

/**
 * Wrap `globalThis.fetch` once per isolate. Requests to `apiOrigin` made inside `withClientAddress`
 * carry the signed address; every other fetch is passed through untouched (same arguments).
 */
export function installApiFetchForwarding(apiOrigin: string): boolean {
  if (installedFor !== null) return true;
  // Next's patched fetch keys its data cache on the request headers it is handed. Our wrapper must sit BELOW it
  // (Next computes the key, then calls down into us), or every shopper would get their own cache entry. On workerd
  // Next patches lazily, inside the server function OpenNext imports on the first request, so installing at module
  // scope puts us underneath. If Next has somehow patched first, forward nothing (the old shared bucket) rather
  // than split the cache.
  if ((globalThis as Record<symbol, unknown>)[NEXT_PATCH_SYMBOL] === true) {
    console.error(
      'SSR client address OFF: fetch was already patched by Next when the Worker entry loaded, so the forward headers would enter its cache key (Ruling RL-SSR-IP-6)'
    );
    return false;
  }
  installedFor = apiOrigin;
  const inner = globalThis.fetch;
  const wrapped = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const fwd = store.getStore();
    if (!fwd || originOf(input) !== apiOrigin) return inner(input, init);
    const base = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    const headers = new Headers(base);
    headers.set(CLIENT_IP_HEADER, fwd.ip);
    headers.set(SSR_AUTH_HEADER, fwd.auth);
    // Keep every other init field (Next's `next: { revalidate, tags }` included). A redirect is NOT followed unless the
    // caller asked for it: the signed address must never be carried to whatever host a 3xx names.
    return inner(input, { ...init, headers, redirect: init?.redirect ?? 'manual' });
  };
  globalThis.fetch = wrapped as typeof fetch;
  return true;
}

/** Run `fn` with this request's client address available to the fetch wrapper. */
export async function withClientAddress<T>(
  request: Request,
  secret: unknown,
  fn: () => Promise<T>
): Promise<T> {
  const ip = request.headers.get('cf-connecting-ip')?.trim();
  if (!ip || typeof secret !== 'string' || secret.length === 0) return store.run(null, fn);
  const auth = await signClientIp(secret, ip);
  return store.run({ ip, auth }, fn);
}

/** Test only: undo the install so a test can install against a fresh fake fetch. */
export function __resetForTests(): void {
  installedFor = null;
}
