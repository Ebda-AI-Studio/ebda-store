/**
 * The production-DB guard, under test.
 *
 * This suite exists because the guard it covers had never once executed. It
 * was inline in `tests/setup-e2e.ts`, gated on a `process.argv` check that is
 * permanently false under `pool: 'forks'`, and its prod check was a denylist
 * of a single endpoint fragment that had gone stale. Nothing failed — the
 * guard simply wasn't there. These tests are the thing that would have caught
 * that, so treat them as load-bearing rather than incidental.
 */
import { describe, it, expect } from 'vitest';
import {
  extractHost,
  isAllowedTestHost,
  assertNotProd,
  isIntegrationTestPath,
  ALLOWED_HOST_PATTERNS,
} from '../helpers/db-guard';

const CI_SERVICE = 'postgresql://test:test@localhost:5432/force_test';
const LOCAL = 'postgresql://test:test@127.0.0.1:5432/test_db';
const STAGING = 'postgresql://u:p@ep-spring-dew-a1nn6819.eu-central-1.aws.neon.tech/neondb';
// The endpoint the repo's own .env points at, i.e. real production.
const PROD =
  'postgresql://neondb_owner:pw@ep-young-wind-asybho8s-pooler.c-4.eu-central-1.aws.neon.tech/neondb?sslmode=require';
// The endpoint the OLD denylist hard-coded. Still must be refused.
const OLD_PROD = 'postgresql://u:p@ep-falling-meadow-a1uq2yil.ap-southeast-1.aws.neon.tech/neondb';

describe('extractHost', () => {
  it('parses the host out of a postgres URL', () => {
    expect(extractHost(CI_SERVICE)).toBe('localhost');
    expect(extractHost(PROD)).toBe('ep-young-wind-asybho8s-pooler.c-4.eu-central-1.aws.neon.tech');
  });

  it('is not fooled by a hostname-shaped password or database name', () => {
    // The old substring check would have matched this and mis-classified it.
    const spoof = 'postgresql://user:localhost@evil.example.com:5432/localhost';
    expect(extractHost(spoof)).toBe('evil.example.com');
    expect(isAllowedTestHost(spoof)).toBe(false);
  });

  it('returns empty (→ refused) for input it cannot parse', () => {
    expect(extractHost('')).toBe('');
    expect(isAllowedTestHost('')).toBe(false);
    expect(isAllowedTestHost('not a url at all')).toBe(false);
  });
});

describe('isAllowedTestHost — allowlist, not denylist', () => {
  it('allows CI, local and staging targets', () => {
    expect(isAllowedTestHost(CI_SERVICE)).toBe(true);
    expect(isAllowedTestHost(LOCAL)).toBe(true);
    expect(isAllowedTestHost(STAGING)).toBe(true);
  });

  it('REFUSES production', () => {
    expect(isAllowedTestHost(PROD)).toBe(false);
  });

  it('still refuses the endpoint the stale denylist named', () => {
    expect(isAllowedTestHost(OLD_PROD)).toBe(false);
  });

  it('fails CLOSED on an endpoint nobody has seen before', () => {
    // The whole point: a renamed / failed-over / newly-added Neon branch must
    // be refused by default, which is precisely where a denylist failed open.
    expect(isAllowedTestHost('postgresql://u:p@ep-brand-new-x9y8z7.aws.neon.tech/neondb')).toBe(
      false
    );
  });
});

describe('assertNotProd', () => {
  it('is silent for an allowlisted host', () => {
    expect(() => assertNotProd(CI_SERVICE, 'CI env')).not.toThrow();
  });

  it('throws for production and names the host it refused', () => {
    expect(() => assertNotProd(PROD, '.env file')).toThrow(/DB GUARD/);
    expect(() => assertNotProd(PROD, '.env file')).toThrow(/ep-young-wind-asybho8s-pooler/);
    expect(() => assertNotProd(PROD, '.env file')).toThrow(/\.env file/);
  });
});

describe('isIntegrationTestPath', () => {
  it('recognises integration and e2e files', () => {
    expect(isIntegrationTestPath('/repo/tests/integration/accounting/po.test.ts')).toBe(true);
    expect(isIntegrationTestPath('/repo/tests/e2e/checkout.test.ts')).toBe(true);
    expect(isIntegrationTestPath('C:\\repo\\tests\\integration\\x.test.ts')).toBe(true);
  });

  it('does NOT match unit tests — they must never trip the guard', () => {
    expect(isIntegrationTestPath('/repo/tests/unit/cart.test.ts')).toBe(false);
    expect(isIntegrationTestPath('/repo/apps/api/src/foo.test.ts')).toBe(false);
  });

  it('returns false when the path is unknown rather than guessing', () => {
    expect(isIntegrationTestPath(undefined)).toBe(false);
    expect(isIntegrationTestPath('')).toBe(false);
  });
});

describe('the allowlist itself', () => {
  it('contains no pattern that would match an arbitrary Neon endpoint', () => {
    const arbitrary = 'ep-anything-at-all.eu-central-1.aws.neon.tech';
    expect(ALLOWED_HOST_PATTERNS.some(re => re.test(arbitrary))).toBe(false);
  });
});
