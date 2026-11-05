/**
 * Worker-level GET /health for the Next apps (admin, orders, web), Ruling HEALTH-ALL-1.
 *
 * Why not a Next route handler: on a Worker deployed without an OpenNext incremental cache (admin and
 * orders) every ROUTE HANDLER throws `No such module "file:/.next/None"` from getIncrementalCache and
 * answers an empty 500, while pages render. So /health is answered in the Worker entry, before OpenNext
 * is ever invoked, and it reports the build identity exactly like api.ebda.app/health:
 *   - commit: `BUILD_COMMIT_SHA`, passed by the deploy workflow (`wrangler deploy --var`);
 *   - deploymentId: the Worker version id from the `CF_VERSION_METADATA` binding.
 * Unknown is `null`, never a guess. No backend is touched; nothing here depends on a phone, order or user.
 */

export interface HealthEnv {
  BUILD_COMMIT_SHA?: unknown;
  CF_VERSION_METADATA?: { id?: unknown } | null;
  [key: string]: unknown;
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** GET or HEAD on exactly `/health`. */
export function isHealthRequest(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  return new URL(request.url).pathname === '/health';
}

export function healthResponse(service: string, env: HealthEnv, method = 'GET'): Response {
  const body = JSON.stringify({
    status: 'ok',
    service,
    commit: nonEmpty(env.BUILD_COMMIT_SHA),
    deploymentId: nonEmpty(env.CF_VERSION_METADATA?.id),
  });
  return new Response(method === 'HEAD' ? null : body, {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

interface FetchHandler<E, C> {
  fetch(request: Request, env: E, ctx: C): Response | Promise<Response>;
}

/** Wrap a Worker (the OpenNext one) so `/health` is answered before it. Everything else is delegated untouched. */
export function withHealth<E extends HealthEnv, C, H extends FetchHandler<E, C>>(
  service: string,
  handler: H
): H & FetchHandler<E, C> {
  return {
    ...handler,
    fetch(request: Request, env: E, ctx: C) {
      if (isHealthRequest(request)) return healthResponse(service, env, request.method);
      return handler.fetch(request, env, ctx);
    },
  };
}
