import type { Request, Response } from 'express';

/**
 * Where an admin search term travels. A phone or an email typed into a search box is PII; in a URL
 * it lands in Cloudflare Workers Logs (full URLs) for the log window (Ruling SEARCH-T5-8), so the
 * admin and Orders-PWA clients send it in this header instead, percent-encoded (a header is
 * Latin-1; Arabic is not). The query-string form stays accepted for older deployed clients and is
 * deprecated. `searchQueryFromHeader` is the one reader.
 */
export const SEARCH_QUERY_HEADER = 'x-search-query';
export const SEARCH_TERM_MAX = 100;

/** The header's term, decoded and bounded; undefined when absent or malformed. */
export function searchQueryFromHeader(req: Request): string | undefined {
  const raw = req.headers[SEARCH_QUERY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value === '') return undefined;
  try {
    const term = decodeURIComponent(value).trim().slice(0, SEARCH_TERM_MAX);
    return term || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The search term of a request: the header first, else `?<param>=` (deprecated). A header-borne term
 * makes the response depend on the header, so it is marked `Vary` and uncacheable by shared caches.
 */
export function searchTermOf(
  req: Request,
  res: Response,
  param: 'search' | 'q'
): string | undefined {
  const fromHeader = searchQueryFromHeader(req);
  if (fromHeader !== undefined) {
    res.vary('X-Search-Query');
    res.setHeader('Cache-Control', 'private, no-store');
    return fromHeader;
  }
  const q = req.query[param];
  return typeof q === 'string' && q.trim() ? q.trim().slice(0, SEARCH_TERM_MAX) : undefined;
}

/** `req.query` with the header's term folded in as `search`, for parsers that read the query. */
export function queryWithSearchHeader(req: Request, res: Response): Request['query'] {
  const term = searchTermOf(req, res, 'search');
  return term === undefined ? req.query : { ...req.query, search: term };
}
