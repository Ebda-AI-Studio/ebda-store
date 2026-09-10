/**
 * Single source of truth for the API base URL used by integration tests.
 *
 * WHY THE KNOB IS NOT `API_URL`
 *
 * `API_URL` is not a free name — it belongs to the SERVER. `.env.example`
 * ships `API_URL=http://localhost:4000` and `apps/api/src/config/index.ts`
 * reads it as `config.apiUrl`, an ORIGIN with no version prefix
 * (`docs/INCIDENT.md` likewise builds `$API_URL/api/v1/inngest` from it).
 * Two failure modes follow from borrowing it for the versioned base:
 *
 *   1. 404 everywhere. Several integration tests import API modules
 *      (`redis.service`, `encryption.service`, `@api/lib/...`) and that import
 *      runs `dotenv.config()` at module load — BEFORE any const in the test
 *      file. So a root `.env` copied from `.env.example` (the documented dev
 *      setup) silently wins, the base becomes `http://localhost:4000`, and
 *      since `apps/api` mounts its routes under `/api/v1`
 *      (`apps/api/src/index.ts`) every request resolves to
 *      `http://localhost:4000/auth/...` → 404. The suite fails in a way that
 *      looks like broken auth rather than broken configuration.
 *
 *   2. Tests firing at production. Deployed environments set
 *      `API_URL=https://api.force-ai.co`. On any machine holding those values,
 *      a local `npm run test:integration` would build a perfectly VALID
 *      production base and then POST `/auth/register` against it, creating
 *      real users in a live tenant. The suite must never be steerable by a
 *      variable whose production value is a real, reachable API.
 *
 * So the knob is test-scoped: `TEST_API_URL`. `TEST_API_BASE` stays honoured
 * as the older alias. Neither has a server-side meaning, so neither can be
 * injected behind the suite's back by `dotenv`.
 *
 * NORMALIZATION
 *
 * Either variable may be given as a bare origin (`http://localhost:4000`) or
 * with the version prefix already attached (`http://localhost:4000/api/v1`).
 * Both normalize to the same `{ API_ORIGIN, API_BASE }` pair, so no caller can
 * produce `/api/v1/api/v1` and no caller has to know which form was set.
 *
 * VALIDATION
 *
 * A bare host is rejected loudly instead of failing cryptically later.
 * `new URL('api.force-ai.co')` throws, and `new URL('localhost:4000')` does
 * NOT throw — it parses `localhost:` as an opaque scheme whose `.origin` is
 * the *string* `"null"`, which is truthy and would flow into every fetch. The
 * protocol check below is what catches that second case; the try/catch alone
 * would not.
 */

const VERSION_PREFIX = '/api/v1';
const DEFAULT_ORIGIN = 'http://localhost:4000';

function resolveRaw(): { raw: string; source: string } {
  if (process.env.TEST_API_URL) return { raw: process.env.TEST_API_URL, source: 'TEST_API_URL' };
  if (process.env.TEST_API_BASE) return { raw: process.env.TEST_API_BASE, source: 'TEST_API_BASE' };

  // Legacy vars set but neither test var: the caller almost certainly believes
  // they have redirected the suite and have not. Falling back to the default
  // silently is the exact "configured but not in effect" failure this helper
  // exists to end, so say so — on stderr, without failing, because the default
  // is still the safe target.
  if (process.env.API_URL || process.env.API_HOST) {
    console.warn(
      `[api-base] API_URL/API_HOST are set but TEST_API_URL is not — those are the ` +
        `SERVER's variables and are ignored here. Using ${DEFAULT_ORIGIN}. ` +
        `Set TEST_API_URL to point the suite somewhere else.`
    );
  }
  return { raw: DEFAULT_ORIGIN, source: 'default' };
}

/**
 * Strip a trailing version prefix (and any trailing slashes) so a value given
 * either way collapses to the same origin. Done as string surgery rather than
 * `new URL(...).origin` so an API mounted under a path prefix
 * (`https://example.com/svc/api/v1`) keeps its `/svc`.
 */
export function normalizeApiOrigin(raw: string, source = 'TEST_API_URL'): string {
  // Strip EVERY trailing version prefix, not one. The docstring's claim is
  // absolute ("no caller can produce /api/v1/api/v1"), and a single strip makes
  // it true only for one level: TEST_API_URL=".../api/v1/api/v1" would collapse
  // to ".../api/v1" and then have the prefix re-appended.
  let origin = raw.trim().replace(/\/+$/, '');
  while (origin.endsWith(VERSION_PREFIX)) {
    origin = origin.slice(0, -VERSION_PREFIX.length).replace(/\/+$/, '');
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(
      `${source}="${raw}" is not a valid absolute URL — include the scheme, ` +
        `e.g. ${DEFAULT_ORIGIN} or ${DEFAULT_ORIGIN}${VERSION_PREFIX}.`
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `${source}="${raw}" has no http(s) scheme (parsed protocol "${parsed.protocol}") — ` +
        `a bare host like "localhost:4000" parses as an opaque URL whose origin is "null". ` +
        `Use ${DEFAULT_ORIGIN} instead.`
    );
  }
  return origin;
}

/**
 * Enforce the safety claim the docstring makes.
 *
 * Choosing a test-scoped variable name stops dotenv injecting a production
 * value BEHIND the suite's back, which is real but partial: it does nothing
 * about someone exporting TEST_API_URL=https://api.force-ai.co by hand and
 * then running a suite that POSTs /auth/register. Until this check existed the
 * promise "the suite must never be steerable at a real, reachable API" was
 * enforced by a naming convention, not by code.
 *
 * Loopback and private ranges are allowed; anything else must opt in
 * explicitly via TEST_API_ALLOW_REMOTE=1, so pointing the suite at a real host
 * is a deliberate act that appears in the command line.
 */
function assertNotAProductionHost(parsed: URL, raw: string, source: string): void {
  if (process.env.TEST_API_ALLOW_REMOTE === '1') return;

  const host = parsed.hostname;
  const isLocal =
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host);

  if (!isLocal) {
    throw new Error(
      `${source}="${raw}" points at a non-local host ("${host}"). The integration ` +
        `suite writes real data (it POSTs /auth/register), so it refuses to run ` +
        `against anything but loopback or a private address. If you genuinely mean ` +
        `to target ${host}, set TEST_API_ALLOW_REMOTE=1 on the same command.`
    );
  }
}

const { raw, source } = resolveRaw();

/** Scheme + host (+ any path prefix), no version segment. Use for `/health`. */
export const API_ORIGIN = normalizeApiOrigin(raw, source);

// Applied HERE, not inside normalizeApiOrigin: that function is pure string
// normalization and is unit-tested with hosts like example.com. The policy —
// "this suite writes real data, so it only targets local addresses" — belongs
// at the boundary where the suite actually adopts a base.
assertNotAProductionHost(new URL(API_ORIGIN), raw, source);

/** The versioned base every `/api/v1` route hangs off. */
export const API_BASE = `${API_ORIGIN}${VERSION_PREFIX}`;
