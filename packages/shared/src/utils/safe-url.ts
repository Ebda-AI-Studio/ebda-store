/**
 * URL-scheme safety helpers — shared by the API (server-side validation) and
 * the storefront (defensive render-time sanitization).
 *
 * Merchant-supplied link fields (hero CTA, announcement link, hero slide
 * `ctaHref`, etc.) are rendered into `<a href>` / Next `<Link href>`. Without
 * a scheme allowlist a merchant (or an attacker who phishes admin access) can
 * store `javascript:alert(1)`, `data:text/html,...`, or `vbscript:...` and turn
 * a stored value into stored XSS the moment a visitor clicks the link.
 *
 * Allowed: site-relative paths (`/...`, `#...`, `?...`, `./`, `../`), plus the
 * `http:`, `https:`, `mailto:` and `tel:` schemes. Everything else is rejected.
 *
 * Defence-in-depth: validate at the Zod schema (so bad values never persist)
 * AND sanitize at every render site (so legacy rows saved before this shipped
 * can't fire).
 */

const ALLOWED_SCHEME_RE = /^(https?:|mailto:|tel:)/i;
// Site-relative / fragment / query / dot-relative — no scheme, so inherently safe.
const RELATIVE_RE = /^(\/|#|\?|\.\/|\.\.\/)/;
// Any leading `scheme:` token (RFC 3986 scheme chars) we don't explicitly allow.
const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * True when the string contains any ASCII control character (0x00–0x1F or
 * 0x7F). Browsers strip TAB/LF/CR when resolving a URL, so `java\tscript:`
 * would otherwise slip past the scheme prefix checks. Implemented via char
 * codes so the source carries no literal control bytes.
 */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * True when `url` is a link we're willing to render: a site-relative path or a
 * value using one of the allowlisted schemes (http/https/mailto/tel). Empty /
 * non-string inputs are NOT considered safe (callers decide the fallback).
 */
export function isSafeUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (hasControlChar(trimmed)) return false;
  if (RELATIVE_RE.test(trimmed)) return true;
  if (ALLOWED_SCHEME_RE.test(trimmed)) return true;
  // A value that carries any other explicit scheme (javascript:, data:,
  // vbscript:, file:, etc.) is unsafe.
  if (HAS_SCHEME_RE.test(trimmed)) return false;
  // No scheme and not matched as relative above (e.g. `example.com/x`):
  // treat as unsafe — the caller should store an absolute or relative URL.
  return false;
}

/**
 * Return `url` when it passes {@link isSafeUrl}, otherwise the supplied
 * `fallback` (default `'#'`). Use at render sites so an unsafe persisted value
 * degrades to an inert link instead of executing.
 */
export function sanitizeUrl(url: unknown, fallback = '#'): string {
  return isSafeUrl(url) ? url.trim() : fallback;
}

/**
 * Validate a post-login `returnTo` / `redirect` target: **internal, same-origin
 * paths only**. Distinct from {@link isSafeUrl} (which allows absolute
 * http/https for merchant link fields) — a redirect target must NEVER leave the
 * site, so absolute URLs, protocol-relative (`//host`), and backslash tricks
 * are all rejected. Returns the cleaned `pathname+search+hash`, or `fallback`.
 *
 * The backslash cases are the subtle ones the naive `startsWith('//')` guard
 * misses: browsers (WHATWG URL) treat `\` as `/` when resolving, so both
 * `//evil.com` and `/\evil.com` resolve to `https://evil.com/`. We reject any
 * backslash outright, then resolve against a throwaway origin as a final belt —
 * anything that changes origin is rejected.
 */
export function safeInternalPath(candidate: unknown, fallback = '/'): string {
  if (typeof candidate !== 'string') return fallback;
  const raw = candidate.trim();
  if (!raw) return fallback;
  if (hasControlChar(raw)) return fallback;
  if (raw[0] !== '/') return fallback; // must be root-relative
  if (raw[1] === '/' || raw[1] === '\\') return fallback; // //host or /\host → offsite
  if (raw.includes('\\')) return fallback; // any backslash → reject
  try {
    const u = new URL(raw, 'https://internal.invalid');
    if (u.origin !== 'https://internal.invalid') return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}
