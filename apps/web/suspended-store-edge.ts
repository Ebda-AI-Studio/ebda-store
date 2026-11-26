/**
 * QA-116: a suspended storefront must answer 503 (not 200) with noindex, so search engines and uptime checks do not
 * treat the maintenance page as the shop's real content.
 *
 * The layout renders the branded page in place of the storefront and Next cannot set a status from a layout, so the edge
 * rewrites it, like `retryableUnavailable` does for an unresolvable store. The layout stamps `data-store-suspended="1"`
 * on `#main-content` when it renders that page. Only a 200 HTML response is looked at, and only its FIRST chunk: the
 * suspended branch has no Suspense boundary, so the whole (small) page is in the first flush. Every other page streams
 * through untouched after that one chunk. A marker that is somehow missed fails SAFE: the page stays a 200.
 */
// pq-allow(unused-export): read by suspended-store-edge.test.ts; the layout stamps the same literal (it must not import Worker code)
export const SUSPENDED_STORE_MARKER = 'data-store-suspended="1"';

export async function suspendedStore503(res: Response): Promise<Response> {
  const type = res.headers.get('content-type') ?? '';
  if (res.status !== 200 || !type.includes('text/html') || !res.body) return res;
  const reader = res.body.getReader();
  const first = await reader.read();
  const head = first.value ? new TextDecoder().decode(first.value, { stream: true }) : '';
  if (!head.includes(SUSPENDED_STORE_MARKER)) {
    // Not suspended: hand the stream back whole (first chunk, then the rest).
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (first.value) controller.enqueue(first.value);
        if (first.done) controller.close();
      },
      async pull(controller) {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel: reason => reader.cancel(reason),
    });
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }
  // Suspended: keep the whole body, change the status and the cache + robots headers.
  const parts: Uint8Array[] = first.value ? [first.value] : [];
  for (let n = first.done ? null : await reader.read(); n && !n.done; n = await reader.read())
    parts.push(n.value);
  const headers = new Headers(res.headers);
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  headers.set('Cache-Control', 'private, no-store');
  headers.delete('content-length');
  headers.delete('etag');
  return new Response(new Blob(parts as BlobPart[]), {
    status: 503,
    statusText: 'Service Unavailable',
    headers,
  });
}
