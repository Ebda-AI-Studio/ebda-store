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
  CORS_CACHE_TTL_MS,
  CORS_LOOKUP_FAILURE_TTL_MS,
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

  it('answers "unavailable" for a fresh unknown/failed-lookup entry, never falling through to the DB (the reported defect)', () => {
    const entry: CorsCacheEntry = { allowed: false, unknown: true, expiresAt: NOW + 1000 };
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
