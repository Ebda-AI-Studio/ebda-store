/**
 * Which authenticated requests may skip the LIVE identity check (Ruling NZ-D2, flipped to deny-by-default by NZ-D10).
 *
 * Merchant / staff / admin access tokens (aud=store) live <= 5 minutes. EVERY authenticated request asks the identity
 * service (revocation + account state, one call) EXCEPT a GET/HEAD/OPTIONS whose exact path is listed in
 * {@link NON_SENSITIVE_GET}. A new route, a renamed route, a path with a suffix (`.json`, `.xlsx`, a trailing segment) or any
 * state change is therefore live by default: the failure mode of forgetting to classify a route is one extra identity call,
 * never a revoked session reading data. tests/unit/auth-sensitivity-routes.test.ts walks the real router table and fails when
 * an allowlist entry matches no route, or when a route the allowlist does not name would skip the check.
 *
 * Add a path ONLY if it returns no personal data, money figure, credential or other store's data (store content the
 * merchant is editing). Cost if wrong: a removed staff member can read that one path for <= 5 minutes.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Exact paths (without the `/api/v1` prefix, `:id` = one path segment). */
export const NON_SENSITIVE_GET: readonly RegExp[] = [
  /^\/onboarding\/slug-check$/, // availability probe before a store exists
  /^\/stores\/[^/]+\/typography$/, // theme font settings
  /^\/admin\/stores\/[^/]+\/layout$/, // storefront layout the merchant is editing
  /^\/admin\/stores\/[^/]+\/builder\/pages\/[^/]+$/, // page-builder draft content
];

/** Request path normalised for matching: no query / hash, no `/api/v1` prefix, no trailing slash. */
export function normalisedPath(req: { originalUrl?: string; url?: string }): string {
  const raw = (req.originalUrl ?? req.url ?? '').split(/[?#]/)[0];
  const p = raw.replace(/^\/api\/v1(?=\/|$)/, '').replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

export function needsLiveIdentity(req: {
  method?: string;
  originalUrl?: string;
  url?: string;
}): boolean {
  // an unknown method is a state change: the default is LIVE
  if (!SAFE_METHODS.has((req.method ?? 'POST').toUpperCase())) return true;
  const path = normalisedPath(req);
  return !NON_SENSITIVE_GET.some(re => re.test(path));
}
