/**
 * Production-database guard for the integration/e2e suites.
 *
 * Extracted from `tests/setup-e2e.ts` into a pure, importable module for one
 * reason: the previous inline version had **never executed**, and nothing
 * could have told us. A guard with no test is indistinguishable from a guard
 * that works. Everything here is side-effect free so `tests/unit/db-guard.test.ts`
 * can assert it actually refuses production.
 *
 * Two independent defects were fixed when this was written (2026-08-31):
 *
 *  1. The suite was detected from `process.argv` at module load. Under Vitest's
 *     `pool: 'forks'` (set in vitest.config.ts) a worker's argv is just
 *     `node …/vitest/dist/workers/forks.js` — it carries NO test paths — so the
 *     flag was permanently false and every line it guarded was dead.
 *
 *  2. The check itself was a DENYLIST of one hard-coded prod endpoint
 *     fragment, which had gone stale: it no longer matched the endpoint the
 *     repo's own `.env` pointed at. A denylist of endpoints fails OPEN the
 *     moment one is renamed, added, or failed over — exactly when it matters.
 *     This is an ALLOWLIST: an unrecognised host is refused, and whoever adds
 *     one has to say so here.
 */

/**
 * Hosts the integration/e2e suites may connect to. These suites seed and
 * delete rows, so add an entry only if you are certain it holds no production
 * data.
 *
 *   - localhost / 127.0.0.1 / ::1 : CI's postgres service container and any
 *                                   local postgres
 *   - host.docker.internal        : postgres on the host, from inside a container
 *   - ep-spring-dew-a1nn6819      : the Neon "preview" branch used for staging
 */
export const ALLOWED_HOST_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /^127\.0\.0\.1$/,
  /^\[?::1\]?$/,
  /^host\.docker\.internal$/i,
  /^ep-spring-dew-a1nn6819(\.|-|$)/i,
];

/**
 * Hostname from a postgres connection string.
 *
 * Uses the URL parser so that a password or database name containing a
 * hostname-shaped substring cannot spoof the check in either direction — the
 * old substring match over the whole string could be fooled both ways. Falls
 * back to a manual split for connection strings the URL parser rejects, and
 * returns '' when even that fails, which the allowlist then refuses.
 */
export function extractHost(connStr: string): string {
  try {
    const u = new URL(connStr);
    // URL keeps IPv6 hosts bracketed; the patterns above accept either form.
    return u.hostname;
  } catch {
    try {
      const withoutScheme = connStr.replace(/^[a-z0-9+]+:\/\/(?:[^@/]*@)?/i, '');
      return withoutScheme.split(/[:/?#]/)[0] ?? '';
    } catch {
      return '';
    }
  }
}

/** Whether this connection string points at a host the suites may touch. */
export function isAllowedTestHost(connStr: string): boolean {
  const host = extractHost(connStr);
  if (!host) return false;
  return ALLOWED_HOST_PATTERNS.some(re => re.test(host));
}

/** Message thrown for a refused host. Exported so the test asserts the real text. */
export function refusalMessage(connStr: string, source: string): string {
  return (
    `\n\n🚨  DB GUARD — refusing to run integration tests against an ` +
    `unrecognised database host.\n` +
    `    These suites seed and delete rows, so an unknown host is treated as ` +
    `production.\n\n` +
    `    Source: ${source}\n` +
    `    Host:   ${extractHost(connStr) || '(unparseable)'}\n\n` +
    `    Point TEST_DATABASE_URL at a local postgres or the staging preview ` +
    `branch\n` +
    `    (ep-spring-dew-a1nn6819). See .env.example.\n` +
    `    If this host is genuinely safe, add it to ALLOWED_HOST_PATTERNS in ` +
    `tests/helpers/db-guard.ts.\n`
  );
}

/** Throws unless `connStr` points at an allowlisted host. */
export function assertNotProd(connStr: string, source: string): void {
  if (isAllowedTestHost(connStr)) return;
  throw new Error(refusalMessage(connStr, source));
}

/**
 * Whether `testPath` is an integration/e2e file.
 *
 * Called with `expect.getState().testPath` inside a `beforeAll`, which is
 * accurate per test file — unlike the module-load `process.argv` read it
 * replaces. Unit tests must not trip the guard just because a developer's
 * local `.env` points at production.
 */
export function isIntegrationTestPath(testPath: string | undefined): boolean {
  if (!testPath) return false;
  return /[\\/]tests[\\/](integration|e2e)[\\/]/.test(testPath);
}
