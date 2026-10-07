// Entry for the isolated PREVIEW storefront worker (ebda-web-preview) ONLY —
// production deploys sentry-worker-entry.ts. Same handler, plus noindex.
// docs/ebda/templates/dahab.md, "Preview stack".
import handler from './sentry-worker-entry';

// The OpenNext Durable Object classes the preview's data cache binds
// (scripts/preview/preview-config.mjs: R2 incremental cache + DO tag cache).
// @ts-expect-error — `.open-next/worker.js` is generated at build time
export { DOQueueHandler, DOShardedTagCache } from './.open-next/worker.js';

/** Every response gets `X-Robots-Tag: noindex, nofollow`; WebSocket upgrades (101) pass through. */
function withNoindex<T extends { fetch?: (...a: never[]) => unknown }>(handler: T): T {
  const inner = handler.fetch as unknown as (
    r: Request,
    e: unknown,
    c: unknown
  ) => Promise<Response>;
  if (!inner) return handler;
  return {
    ...handler,
    async fetch(req: Request, env: unknown, ctx: unknown) {
      const res = await inner.call(handler, req, env, ctx);
      if (res.status === 101) return res;
      const headers = new Headers(res.headers);
      headers.set('X-Robots-Tag', 'noindex, nofollow');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    },
  } as T;
}

export default withNoindex(handler as never);
