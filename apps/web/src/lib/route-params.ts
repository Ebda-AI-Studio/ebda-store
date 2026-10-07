/**
 * Dynamic-route param decoding.
 *
 * WHY THIS EXISTS (bug, 2026-07-29 — demo-store Arabic product 404s):
 * Next.js does NOT hand the same value to `generateMetadata` and to the page
 * component for the same dynamic segment. For
 * `/products/%D8%AE%D8%A8%D9%8A%D8%B5%D9%87`:
 *
 *   generateMetadata → params.slug === 'خبيصه'                  (decoded)
 *   page component   → params.slug === '%D8%AE%D8%A8%D9%8A...'  (raw)
 *
 * Every server component then did `encodeURIComponent(slug)` before calling
 * the API, so the page's already-encoded value got DOUBLE-encoded
 * (`%25D8%25AE…`), the API 404'd, and `notFound()` fired — while the metadata
 * from the same render resolved fine. Result: a real product served a branded
 * "page not available" body under a correct `<title>`/og:image, at HTTP 200
 * (the shell had already flushed) — a soft 404 that Google indexes as broken.
 *
 * Pure-ASCII slugs never showed it: Next normalizes unreserved escapes
 * (`%61` → `a`) before routing, so only non-ASCII (Arabic) slugs survive to
 * the page component still encoded. Every Arabic product/blog handle on every
 * store was affected.
 *
 * The helper is IDEMPOTENT — safe to apply whichever form Next hands over.
 */

/**
 * Decode a dynamic route segment exactly once, tolerating values Next has
 * already decoded.
 *
 * - `'خبيصه'`        → `'خبيصه'`  (no escapes to decode — no-op)
 * - `'%D8%AE%D8%A8'` → `'خب'`     (raw segment — decoded)
 * - `'50%-off'`      → `'50%-off'` (malformed escape — returned untouched
 *                                   rather than throwing a 500)
 */
export function decodeRouteParam(value: string): string {
  if (!value || !value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    // Not a valid percent-escape sequence (e.g. a literal '%' in the slug).
    // Returning the raw value keeps today's behavior for that segment instead
    // of turning a 404 into an unhandled URIError → 500.
    return value;
  }
}
