// Host allowlist for the storefront search load test (review M-6). Plain ES module so k6 can import
// it and the unit test can too. The test writes the search log and spends the Workers AI
// query-embed budget: it may run against localhost, or against the exact preview hosts named in
// LOADTEST_ALLOWED_HOSTS (comma-separated, no wildcards). Production is refused even if listed.

const LOCAL = ['localhost', '127.0.0.1', '[::1]'];
// Refused even when allowlisted: the apex and every subdomain of the production domain, and any
// workers.dev host whose name looks like the production API Worker.
const PRODUCTION = host =>
  host === 'ebda.app' || host.endsWith('.ebda.app') || host === 'ebda-api.workers.dev';

/** The host of an http(s) URL, lower-case, without userinfo or port; null if it is not one. */
export function hostOf(url) {
  const m = /^https?:\/\/([^/?#]*)/i.exec(String(url || '').trim());
  if (!m) return null;
  let authority = m[1];
  const at = authority.lastIndexOf('@'); // userinfo: `localhost@evil.com` is evil.com
  if (at >= 0) authority = authority.slice(at + 1);
  const host = authority.startsWith('[')
    ? authority.slice(0, authority.indexOf(']') + 1)
    : authority.split(':')[0];
  return host ? host.toLowerCase() : null;
}

export function assertAllowedHost(base, extraAllowed) {
  const host = hostOf(base);
  if (!host) throw new Error('BASE_URL is not an http(s) URL');
  if (PRODUCTION(host))
    throw new Error(`refusing to run the search load test against production (${host})`);
  const extra = String(extraAllowed || '')
    .split(',')
    .map(h => h.trim().toLowerCase())
    .filter(Boolean);
  if (!LOCAL.includes(host) && !extra.includes(host))
    throw new Error(
      `${host} is not allowed: use localhost, or list the exact preview host in LOADTEST_ALLOWED_HOSTS`
    );
}
