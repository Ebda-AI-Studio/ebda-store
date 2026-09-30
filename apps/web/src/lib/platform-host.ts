/**
 * Canonical platform-host detection — the SINGLE source of truth shared by the
 * storefront middleware (server) AND `useStoreUrl` in StoreContext (client).
 *
 * Why this MUST be shared: when the two lists drift, store `<Link>` hrefs lose
 * the `/<slug>` prefix on a platform host the client side doesn't recognize.
 * The CF migration added `store.force-ai.co` to the middleware's list but NOT
 * to the client check — so on `store.force-ai.co` the Home link pointed at `/`
 * (platform landing / demo store) and the store context was lost on refresh
 * ("Unable to resolve store context"). Regression verified 2026-06-27.
 *
 * Rule: every platform host lives HERE. Never hardcode a subset anywhere else.
 */
export const PLATFORM_HOSTS = new Set<string>([
  'localhost',
  '127.0.0.1',
  'forcemediakw.com',
  'www.forcemediakw.com',
  'admin.forcemediakw.com',
  'app.forcemediakw.com',
  'store.forcemediakw.com',
  // force-ai.co — the 2026-06 platform domain rebrand (Vercel → Cloudflare).
  // store.force-ai.co is the path-based storefront platform host (`/<slug>`).
  'force-ai.co',
  'www.force-ai.co',
  'store.force-ai.co',
  'admin.force-ai.co',
  'orders.force-ai.co',
]);

/**
 * Hosting-provider suffixes — ANY subdomain is a platform preview host (preview
 * deploys, tunnels). Production custom merchant domains never end with these.
 * `workers.dev` is the Cloudflare Workers / OpenNext preview target.
 * (Vercel cancelled 2026-07 — `vercel.app` removed; the platform runs solely
 * on Cloudflare Workers now.)
 */
export const PLATFORM_SUFFIXES = ['netlify.app', 'ngrok.io', 'ngrok-free.app', 'workers.dev'];

/**
 * True when `hostname` is a platform domain (not a merchant custom domain).
 * Strips the port and lowercases before matching.
 */
export function isPlatformHost(hostname: string): boolean {
  if (!hostname) return false;
  const host = hostname.split(':')[0].toLowerCase();
  if (PLATFORM_HOSTS.has(host)) return true;
  return PLATFORM_SUFFIXES.some(suffix => host.endsWith(`.${suffix}`));
}

/**
 * Read middleware's `x-is-platform` request header as a TRI-state (#2091).
 *
 * `middleware.ts` asserts it on every request it handles — `'true'` on a
 * platform host, `'false'` on a custom domain — after stripping any
 * client-supplied value. ABSENT therefore means "middleware did not run for
 * this render", which is exactly when StoreProvider must fall back to its
 * client-side `isPlatformHost()` detection. Collapsing absent to `false`
 * (the old `=== 'true'`) silently disabled that fallback.
 */
export function isPlatformFromHeader(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  return value === 'true';
}
