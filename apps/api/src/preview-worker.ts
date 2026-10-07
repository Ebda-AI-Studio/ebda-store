// Entry for the isolated PREVIEW API worker (ebda-api-preview) ONLY — the
// production worker's entry is ./worker.ts. Same app, plus noindex headers.
// docs/ebda/templates/dahab.md, "Preview stack".
import worker from './worker';

export { AuthState } from './cf/auth-state';
export { StoreRealtime } from './cf/store-realtime';
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

export default withNoindex(worker as never);
