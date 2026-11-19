/**
 * The guest order-status page `/o/<token>` (Ruling WA-COD-V2-2) is reached by a bearer link: never cached, never indexed, and it
 * sends no referrer. Applied by the middleware to every response for that path (page, rewrite, redirect or 404).
 */
const ORDER_LINK_PATH = /^\/o\/[^/]+\/?$/;

export function applyOrderLinkHeaders(pathname: string, headers: Headers): void {
  if (!ORDER_LINK_PATH.test(pathname)) return;
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
}
