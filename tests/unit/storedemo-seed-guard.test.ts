import { describe, it, expect } from 'vitest';
// @ts-expect-error plain .mjs script
import { guard, isLocalUrl, describePlan, CATALOGUE } from '../../scripts/storedemo/seed.mjs';

// Built from parts so secretlint does not read a fixture as a leaked connection string.
const pg = (rest: string) => ['postgresql', '://', rest].join('');

describe('storedemo seed guard', () => {
  it('allows loopback hosts', () => {
    for (const u of [pg('a:b@localhost:5432/x'), pg('a:b@127.0.0.1/x'), pg('a:b@[::1]:5432/x')])
      expect(guard(u, []).ok).toBe(true);
  });
  it('refuses a remote host unless --yes-production', () => {
    const remote = pg('a:b@ep-x.eu-central-1.aws.neon.tech/db');
    expect(isLocalUrl(remote)).toBe(false);
    expect(guard(remote, []).ok).toBe(false);
    expect(guard(remote, ['--allow-remote']).ok).toBe(false);
    expect(guard(remote, ['--yes-production']).ok).toBe(true);
  });
  it('refuses a missing or invalid url', () => {
    expect(guard(undefined, ['--yes-production']).ok).toBe(false);
    expect(guard('not a url', ['--yes-production']).ok).toBe(false);
  });
  it('the plan names the host and the counts, and never the credentials', () => {
    const plan = describePlan(pg('user:secretpw@localhost:5432/x'));
    expect(plan).toContain('localhost');
    expect(plan).not.toContain('secretpw');
    expect(plan).toContain(
      `products: ${CATALOGUE.reduce((n: number, c: { products: unknown[] }) => n + c.products.length, 0)}`
    );
  });
});
