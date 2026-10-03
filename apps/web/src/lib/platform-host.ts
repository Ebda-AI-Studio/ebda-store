/**
 * Platform-host detection — a thin wrapper over the ONE host classifier,
 * `parseStoreHost` in `@force/shared`, shared by the storefront middleware
 * (server) AND `StoreProvider` (client) so the two can never drift.
 *
 * A host is either a STORE host (`<slug>.ebda.app` or a merchant custom
 * domain) or it is not. "Platform" here means "not a store host": the apex,
 * `app.`/`api.`/… service hosts, preview hosts, and anything unparseable. A
 * platform host never renders a store — there is no `/<slug>` path entry any
 * more (program plan §1: every store lives at `<slug>.ebda.app`).
 */
import { parseStoreHost, PREVIEW_HOST_SUFFIXES } from '@force/shared';

/** Hosting-provider preview suffixes (re-exported for callers that list them). */
export const PLATFORM_SUFFIXES: readonly string[] = PREVIEW_HOST_SUFFIXES;

/** `<slug>.ebda.localhost` / `<slug>.localhost` are store hosts outside production only. */
export function devSuffixesAllowed(): boolean {
  return process.env.NODE_ENV !== 'production';
}

/**
 * True when `hostname` is NOT a store host. Strips the port and lowercases
 * (via `parseStoreHost`). An empty hostname is not a platform host.
 */
export function isPlatformHost(hostname: string): boolean {
  if (!hostname) return false;
  const parsed = parseStoreHost(hostname, { allowDevSuffixes: devSuffixesAllowed() });
  return parsed.kind !== 'subdomain' && parsed.kind !== 'custom';
}

/**
 * Read middleware's `x-is-platform` request header as a TRI-state (#2091).
 *
 * `middleware.ts` asserts it on every request it handles — `'true'` on a
 * platform host, `'false'` on a store host — after stripping any
 * client-supplied value. ABSENT therefore means "middleware did not run for
 * this render", which is exactly when StoreProvider must fall back to its
 * client-side `isPlatformHost()` detection. Collapsing absent to `false`
 * (the old `=== 'true'`) silently disabled that fallback.
 */
export function isPlatformFromHeader(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  return value === 'true';
}
