/**
 * Ruling RESOLVE-BULLETPROOF-1 (layer 5): "we could not ask the API who owns this host, and hold no safe copy" is a
 * 503 with Retry-After, never a 500.
 *
 * A page body that cannot resolve its store throws StoreTemporarilyUnavailableError (digest
 * `STORE_TEMPORARILY_UNAVAILABLE`, src/lib/store-unavailable.ts) into `app/error.tsx`, and Next answers that render with
 * HTTP 500. Next cannot set a status from an error boundary, so the edge rewrites it: only a 500 HTML response is read
 * (the happy path costs nothing), and only one carrying that digest becomes a 503. The body (the retry page) is kept.
 * `Cache-Control: no-store`, and the edge HTML caches store only a 200 (`isStorableHtml`), so the transient answer is
 * cached nowhere. Wired into `serveDemoEdge`, the outermost wrapper every storefront page passes through.
 */
export const STORE_UNAVAILABLE_MARKER = 'STORE_TEMPORARILY_UNAVAILABLE';
export const UNAVAILABLE_RETRY_AFTER_S = 30;

export async function retryableUnavailable(res: Response): Promise<Response> {
  if (res.status !== 500 || !(res.headers.get('content-type') ?? '').includes('text/html'))
    return res;
  const body = await res.text();
  const headers = new Headers(res.headers);
  if (!body.includes(STORE_UNAVAILABLE_MARKER)) return new Response(body, { status: 500, headers });
  headers.set('Retry-After', String(UNAVAILABLE_RETRY_AFTER_S));
  headers.set('Cache-Control', 'private, no-store');
  headers.delete('content-length');
  return new Response(body, { status: 503, statusText: 'Service Unavailable', headers });
}
