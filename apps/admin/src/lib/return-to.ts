/**
 * Sanitize a `?returnTo=` querystring value against an open-redirect: only a
 * value that starts with `base` (the plain, in-app URL for this page) is
 * trusted; anything else falls back to `base`.
 *
 * `raw` MUST already be decoded exactly once — `useSearchParams().get()`
 * (URLSearchParams) does that itself. Product new/edit pages both used to
 * call `decodeURIComponent(raw)` here too, a SECOND decode of an
 * already-decoded string. A `returnTo` containing a literal `%` (e.g. a
 * product-list filter typed with `%` in a search term) either threw inside
 * the caller's try/catch (silently falling back to `base`) or, if it
 * happened to look like valid percent-encoding, misdecoded into a different
 * string that could still pass the `startsWith` guard. #670.
 */
export function sanitizeReturnTo(raw: string | null | undefined, base: string): string {
  if (!raw) return base;
  return raw.startsWith(base) ? raw : base;
}
