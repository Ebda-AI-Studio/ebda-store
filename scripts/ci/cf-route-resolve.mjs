/**
 * cf-route-resolve.mjs - which Workers route serves a URL? A model of Cloudflare's documented matching, used by
 * tests/unit/cf-route-precedence.test.ts to prove the storefront's `star/star` (merchant custom domains, M-072) never out-ranks an
 * explicit route.
 *
 * Documented rules (https://developers.cloudflare.com/workers/configuration/routing/routes/#matching-behavior):
 *  - `*` matches zero or more of ANY character; a hostname pattern starting `*.` matches subhosts only, starting `*` matches the
 *    host and subhosts; no scheme = http and https.
 *  - When more than one pattern could match, the MOST SPECIFIC wins. Documented examples: `www.example.com/<any>` beats
 *    `*.example.com/<any>`; `example.com/hello/<any>` beats `example.com/<any>`.
 *  - A route WITHOUT a Worker negates less specific patterns (an exclusion).
 * Cloudflare does not publish its exact specificity formula; this model orders by literal (non-`*`) hostname characters, then
 * literal path characters, which reproduces both documented examples. The plan avoids depending on the formula: every hostname
 * the zone serves has a route that is more specific than `star/star` by ANY reasonable ordering (it names the host).
 */
export function patternToRegex(pattern) {
  const noScheme = pattern.replace(/^https?:\/\//, '');
  const esc = noScheme.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${esc}$`);
}

/** literal characters outside `*`, host part first then path part */
export function specificity(pattern) {
  const noScheme = pattern.replace(/^https?:\/\//, '');
  const slash = noScheme.indexOf('/');
  const host = slash < 0 ? noScheme : noScheme.slice(0, slash);
  const pathPart = slash < 0 ? '' : noScheme.slice(slash);
  return [host.replace(/\*/g, '').length, pathPart.replace(/\*/g, '').length];
}

/** routes: [{ pattern, worker|null }]. Returns the winning route, or null when none matches. */
export function resolve(url, routes) {
  const u = new URL(url);
  const target = `${u.host}${u.pathname}${u.search}`;
  const hit = routes
    .filter(
      r =>
        patternToRegex(r.pattern).test(target) ||
        (u.pathname === '/' && patternToRegex(r.pattern).test(u.host))
    )
    .sort((a, b) => {
      const [ah, ap] = specificity(a.pattern);
      const [bh, bp] = specificity(b.pattern);
      return bh - ah || bp - ap;
    });
  return hit[0] ?? null;
}
