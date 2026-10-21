/**
 * Search eval safety guards (Task 13 review M3). The harness WRITES a store to DATABASE_URL and
 * INCRs the shared embed-budget counters (with its caps lifted) in REDIS_URL, so both must be
 * loopback: a production URL left in the shell must never be touched. Errors name the variable
 * and the host, never the URL (it carries credentials).
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function assertLocal(name: string, url: string | undefined): string {
  if (!url) throw new Error(`${name} is required (a LOCAL scratch instance)`);
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  if (!LOOPBACK.has(host))
    throw new Error(`refusing a non-local ${name} host (${host}): the eval writes to it`);
  return url;
}

/** Both targets the eval writes to must be loopback; returns them. */
export function assertLocalTargets(env: Record<string, string | undefined>): {
  databaseUrl: string;
  redisUrl: string;
} {
  return {
    databaseUrl: assertLocal('DATABASE_URL', env.DATABASE_URL),
    redisUrl: assertLocal('REDIS_URL', env.REDIS_URL),
  };
}
