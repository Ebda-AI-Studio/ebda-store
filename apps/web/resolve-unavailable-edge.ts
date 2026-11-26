/**
 * Ruling RESOLVE-BULLETPROOF-1 (layer 5): "we could not ask the API who owns this host, and hold no safe copy" is a
 * 503 with Retry-After, never a 500.
 *
 * A page body that cannot resolve its store throws StoreTemporarilyUnavailableError (digest
 * `STORE_TEMPORARILY_UNAVAILABLE`, src/lib/store-unavailable.ts) into `app/error.tsx`, and Next answers that render with
 * HTTP 500. Next cannot set a status from an error boundary, so the edge rewrites it: only a 500 HTML response is read
 * (the happy path costs nothing); a client-side navigation's RSC response (`text/x-component`) gets the same treatment, and only one carrying that digest becomes a 503. The body (the retry page) is kept.
 * `Cache-Control: no-store`, and the edge HTML caches store only a 200 (`isStorableHtml`), so the transient answer is
 * cached nowhere. Wired into `serveDemoEdge`, the outermost wrapper every storefront page passes through.
 */
export const STORE_UNAVAILABLE_MARKER = 'STORE_TEMPORARILY_UNAVAILABLE';
export const UNAVAILABLE_RETRY_AFTER_S = 30;

/**
 * R1: a sitemap that could not ask its API (`SitemapSourceUnavailableError`, app/sitemap.ts) fails the render on purpose so
 * Google keeps its last-good sitemap. Next answers that with a bare 500 that carries no marker; on a sitemap path the only
 * expected 500 IS that error, so it leaves as the same 503 + Retry-After a page gets (Search Console retries both).
 */
const SITEMAP_PATH = /^\/sitemap[^/]*\.xml$/;

export async function retryableUnavailable(res: Response, path?: string): Promise<Response> {
  if (res.status === 500 && path && SITEMAP_PATH.test(path)) {
    const headers = new Headers(res.headers);
    headers.set('Retry-After', String(UNAVAILABLE_RETRY_AFTER_S));
    headers.set('Cache-Control', 'private, no-store');
    headers.set('Content-Type', 'text/plain; charset=utf-8');
    headers.delete('content-length');
    return new Response('Service Unavailable', {
      status: 503,
      statusText: 'Service Unavailable',
      headers,
    });
  }
  const type = res.headers.get('content-type') ?? '';
  // A full page (text/html) or a client navigation's RSC payload (text/x-component) carry the same digest.
  if (res.status !== 500 || !(type.includes('text/html') || type.includes('text/x-component')))
    return res;
  const body = await res.text();
  const headers = new Headers(res.headers);
  if (!body.includes(STORE_UNAVAILABLE_MARKER)) return new Response(body, { status: 500, headers });
  headers.set('Retry-After', String(UNAVAILABLE_RETRY_AFTER_S));
  headers.set('Cache-Control', 'private, no-store');
  headers.delete('content-length');
  return new Response(body, { status: 503, statusText: 'Service Unavailable', headers });
}
