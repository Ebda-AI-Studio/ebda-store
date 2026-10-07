// Entry for the isolated PREVIEW admin worker (ebda-admin-preview) ONLY —
// production deploys .open-next/worker.js directly. Same handler, plus noindex.
// docs/ebda/templates/dahab.md, "Preview stack".
// @ts-expect-error — `.open-next/worker.js` is generated at build time
import handler from './.open-next/worker.js';

// @ts-expect-error — generated at build time (the OpenNext DO classes, when present)
export * from './.open-next/worker.js';
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
