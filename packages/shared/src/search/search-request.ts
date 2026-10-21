/**
 * Admin / Orders-PWA search requests keep the typed term OUT of the URL (Ruling SEARCH-P2-9, which
 * extends SEARCH-T5-8): a phone or an email in a query string is retained in Cloudflare Workers
 * Logs. The term travels in this header, percent-encoded (a header is Latin-1; Arabic is not). The
 * API reads it with `searchQueryFromHeader` and still accepts the old `?search=` / `?q=`.
 */
export const SEARCH_QUERY_HEADER = 'X-Search-Query';

/** The request header carrying `term` (empty object for a blank term). */
export function searchQueryHeaders(term: string | undefined | null): Record<string, string> {
  const t = (term ?? '').trim().slice(0, 100);
  return t ? { [SEARCH_QUERY_HEADER]: encodeURIComponent(t) } : {};
}

/**
 * Take `key` (default `search`) out of `params` and return it as a header: the URL keeps the other
 * filters, the term rides in the header. `params` is not mutated.
 */
export function moveSearchToHeader(
  params: URLSearchParams,
  key = 'search'
): { params: URLSearchParams; headers: Record<string, string> } {
  const rest = new URLSearchParams(params);
  const term = rest.get(key);
  rest.delete(key);
  return { params: rest, headers: searchQueryHeaders(term) };
}
