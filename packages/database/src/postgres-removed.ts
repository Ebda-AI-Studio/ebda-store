// NEON-ZERO N-17 (Ruling NZ-D23): the Worker has no Postgres. A client that FAILS LOUD on first use so a path
// the sweep missed surfaces at once as a clear error, instead of opening a socket to a host that no longer exists
// (a hang until the Worker's wall-clock limit). Node, tests and dev keep the real client (`getProcessClient`).
import type { AppPrismaClient } from './client';

export const POSTGRES_REMOVED = 'POSTGRES_REMOVED';

export class PostgresRemovedError extends Error {
  readonly code = POSTGRES_REMOVED;
  constructor(readonly access: string) {
    super(
      `${POSTGRES_REMOVED}: Postgres was removed from the Worker (NEON-ZERO); a Prisma call (${access}) ` +
        'reached the database layer. Port this path to the StoreDO / D1.'
    );
    this.name = 'PostgresRemovedError';
  }
}

/**
 * A client whose every use throws `PostgresRemovedError`. `onFirst` runs once per client factory (the Worker passes one
 * that logs and sends a P1 alert once per isolate). `$disconnect` is a no-op so `runWithRequestDb` can release it.
 */
export function createPostgresRemovedClient(
  onFirst?: (err: PostgresRemovedError) => void
): AppPrismaClient {
  let reported = false;
  const fail = (access: string): never => {
    const err = new PostgresRemovedError(access);
    if (!reported) {
      reported = true;
      try {
        onFirst?.(err);
      } catch {
        // an alert failure must not mask the real error
      }
    }
    throw err;
  };
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (prop === '$disconnect') return async () => undefined;
      // Promise/inspection probes (`await client`, util.inspect, JSON) must not count as a database call.
      if (prop === 'then' || typeof prop === 'symbol' || prop === 'toJSON') return undefined;
      return new Proxy(function () {}, {
        get: (_f, sub) =>
          typeof sub === 'symbol' ? undefined : fail(`${String(prop)}.${String(sub)}`),
        apply: () => fail(String(prop)),
      });
    },
  };
  return new Proxy({}, handler) as unknown as AppPrismaClient;
}

/** Who reached the removed client: the cron job / queue / job id (reach label) and the first 8 stack frames. */
export function postgresRemovedWhere(
  err: Error,
  label: string | undefined
): { caller: string; frames: string[] } {
  const frames = (err.stack ?? '')
    .split('\n')
    .filter(l => /^\s+at /.test(l))
    .slice(0, 8)
    .map(l => l.trim());
  return { caller: label ?? '(request or unlabelled path)', frames };
}
