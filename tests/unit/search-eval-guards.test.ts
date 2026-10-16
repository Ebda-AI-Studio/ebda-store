// Search eval harness (Task 13 review M3): it writes a store to DATABASE_URL and INCRs the shared
// embed-budget counters in REDIS_URL, so both must be loopback. No network.
import { describe, it, expect } from 'vitest';
import { assertLocalTargets } from '../search-eval/guards';

const DB = 'postgresql://u:p@127.0.0.1:5432/db';
const REDIS = 'redis://127.0.0.1:6379';

describe('assertLocalTargets', () => {
  it('accepts loopback database and redis', () => {
    expect(() => assertLocalTargets({ DATABASE_URL: DB, REDIS_URL: REDIS })).not.toThrow();
    expect(() =>
      assertLocalTargets({
        DATABASE_URL: 'postgresql://u:p@localhost/db',
        REDIS_URL: 'redis://[::1]:6379',
      })
    ).not.toThrow();
  });

  it('refuses a missing or non-local REDIS_URL', () => {
    expect(() => assertLocalTargets({ DATABASE_URL: DB })).toThrow(/REDIS_URL/);
    expect(() =>
      assertLocalTargets({ DATABASE_URL: DB, REDIS_URL: 'rediss://default:x@prod.upstash.io:6379' })
    ).toThrow(/REDIS_URL/);
  });

  it('refuses a missing or non-local DATABASE_URL', () => {
    expect(() => assertLocalTargets({ REDIS_URL: REDIS })).toThrow(/DATABASE_URL/);
    expect(() =>
      assertLocalTargets({ DATABASE_URL: 'postgresql://u:p@ep-x.neon.tech/db', REDIS_URL: REDIS })
    ).toThrow(/DATABASE_URL/);
    // a hostname that merely starts with "localhost" is not loopback
    expect(() =>
      assertLocalTargets({
        DATABASE_URL: 'postgresql://u:p@localhost.evil.com/db',
        REDIS_URL: REDIS,
      })
    ).toThrow(/DATABASE_URL/);
  });

  it('never echoes the credentials in the error', () => {
    let msg = '';
    try {
      assertLocalTargets({
        DATABASE_URL: DB,
        REDIS_URL: 'redis://default:s3cret@prod.example.com',
      });
    } catch (e) {
      msg = String(e);
    }
    expect(msg).toMatch(/REDIS_URL.*prod\.example\.com/);
    expect(msg).not.toContain('s3cret');
  });
});
