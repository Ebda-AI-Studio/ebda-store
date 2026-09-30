/**
 * #1074 — the CORS custom-domain lookup's `.catch` built an `AppError(503,
 * 'CORS_LOOKUP_UNAVAILABLE', ...)` but never populated `corsDomainCache`.
 * During a Neon outage / pool starvation, every request for a custom domain
 * re-issued the same `prisma.store.findFirst` against the already-degraded
 * database — the negative-cache miss that this cache exists to prevent.
 *
 * `decideCorsCache` is the pure decision `index.ts`'s CORS origin-check now
 * delegates to, so the fix (a short-TTL `unknown: true` entry written on a
 * failed lookup, read back as 'unavailable' rather than falling through to
 * the DB) is testable without booting the Express app.
 *
 * Mutation-proof: dropping the `if (cached.unknown) return 'unavailable'`
 * branch (restoring the pre-fix shape, where an `unknown` entry falls
 * through to `cached.allowed ? 'allow' : 'reject'`) reddens
 * "an unknown/failed-lookup entry answers 'unavailable', never 'miss'".
 */
import { describe, it, expect } from 'vitest';
import {
  decideCorsCache,
  corsEntryAfterFailure,
  corsEntryAfterLookup,
  decideAfterFailedLookup,
  CORS_CACHE_TTL_MS,
  CORS_LOOKUP_FAILURE_TTL_MS,
  CORS_STALE_SERVE_MAX_MS,
  type CorsCacheEntry,
} from '../../apps/api/src/lib/cors-cache';

const NOW = 1_700_000_000_000;

describe('decideCorsCache', () => {
  it('is a miss when there is no cached entry', () => {
    expect(decideCorsCache(undefined, NOW)).toBe('miss');
  });

  it('is a miss when the entry has expired', () => {
    const expired: CorsCacheEntry = { allowed: true, expiresAt: NOW - 1 };
    expect(decideCorsCache(expired, NOW)).toBe('miss');
  });

  it('allows a fresh resolved-allowed entry', () => {
    const entry: CorsCacheEntry = { allowed: true, expiresAt: NOW + 1000 };
    expect(decideCorsCache(entry, NOW)).toBe('allow');
  });

  it('rejects a fresh resolved-disallowed entry', () => {
    const entry: CorsCacheEntry = { allowed: false, expiresAt: NOW + 1000 };
    expect(decideCorsCache(entry, NOW)).toBe('reject');
  });

  it('answers "unavailable" for a repeated failed lookup on a never-resolved hostname, never falling through to the DB (the reported defect)', () => {
    const entry: CorsCacheEntry = {
      allowed: false,
      unknown: true,
      failures: 2,
      expiresAt: NOW + 1000,
    };
    expect(decideCorsCache(entry, NOW)).toBe('unavailable');
  });

  it('an expired unknown entry is a miss (so the DB is retried once the short TTL elapses)', () => {
    const entry: CorsCacheEntry = { allowed: false, unknown: true, expiresAt: NOW - 1 };
    expect(decideCorsCache(entry, NOW)).toBe('miss');
  });

  it('the failure TTL is much shorter than the success TTL (fast self-heal, not a long false-negative window)', () => {
    expect(CORS_LOOKUP_FAILURE_TTL_MS).toBeLessThan(CORS_CACHE_TTL_MS);
  });
});

/**
 * issue 2109 / issue 2169 — one transient lookup failure used to overwrite the
 * last-known-good entry and 503 the whole merchant hostname for 5s.
 *
 * Mutation-proof: dropping the `failures < CORS_FAILURES_BEFORE_UNAVAILABLE`
 * branch reddens "a SINGLE failure still lets the next request re-query";
 * dropping `staleAnswer` from decideCorsCache reddens "a verified domain keeps
 * passing through an outage".
 */
describe('CORS lookup failure — blip vs outage (issue 2109, issue 2169)', () => {
  it('a SINGLE failure still lets the next request re-query (one blip costs one request)', () => {
    const entry = corsEntryAfterFailure(undefined, NOW);
    expect(entry.failures).toBe(1);
    expect(decideCorsCache(entry, NOW + 1)).toBe('miss');
  });

  it('a second consecutive failure on a never-resolved hostname short-circuits to 503', () => {
    const first = corsEntryAfterFailure(undefined, NOW);
    const second = corsEntryAfterFailure(first, NOW + 10);
    expect(second.failures).toBe(2);
    expect(decideCorsCache(second, NOW + 20)).toBe('unavailable');
    expect(decideAfterFailedLookup(second, NOW + 10)).toBe('unavailable');
  });

  it('a verified domain keeps passing through an outage — the expired positive is NOT thrown away', () => {
    const verified = corsEntryAfterLookup(true, NOW);
    const later = NOW + CORS_CACHE_TTL_MS + 1; // positive entry expired
    expect(decideCorsCache(verified, later)).toBe('miss');
    const failed = corsEntryAfterFailure(verified, later);
    expect(failed.lastKnownAllowed).toBe(true);
    expect(decideAfterFailedLookup(failed, later)).toBe('allow');
    expect(decideCorsCache(failed, later + 1)).toBe('allow');
    // …and keeps it across further consecutive failures.
    const again = corsEntryAfterFailure(failed, later + CORS_LOOKUP_FAILURE_TTL_MS + 1);
    expect(again.failures).toBe(2);
    expect(decideCorsCache(again, later + CORS_LOOKUP_FAILURE_TTL_MS + 2)).toBe('allow');
  });

  it('a known NON-match stays rejected through an outage (never upgraded to allow)', () => {
    const rejected = corsEntryAfterLookup(false, NOW);
    const failed = corsEntryAfterFailure(rejected, NOW + CORS_CACHE_TTL_MS + 1);
    expect(decideAfterFailedLookup(failed, NOW + CORS_CACHE_TTL_MS + 1)).toBe('reject');
  });

  it('the stale answer is bounded — a domain last verified too long ago answers 503', () => {
    const verified = corsEntryAfterLookup(true, NOW);
    const tooLate = NOW + CORS_STALE_SERVE_MAX_MS + 1;
    const f1 = corsEntryAfterFailure(verified, tooLate);
    const f2 = corsEntryAfterFailure(f1, tooLate + 1);
    expect(decideAfterFailedLookup(f2, tooLate + 1)).toBe('unavailable');
    expect(decideCorsCache(f2, tooLate + 2)).toBe('unavailable');
  });

  it('a successful lookup resets the failure count', () => {
    const f1 = corsEntryAfterFailure(undefined, NOW);
    const ok = corsEntryAfterLookup(true, NOW + 1);
    expect(ok.unknown).toBeUndefined();
    expect(corsEntryAfterFailure(ok, NOW + 2).failures).toBe(1);
    expect(f1.failures).toBe(1);
  });
});
