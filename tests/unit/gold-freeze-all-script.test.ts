import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script, no types
import { CHUNK, chunk, main, parseArgs } from '../../scripts/gold-rate/freeze-all.mjs';

describe('gold-rate/freeze-all.mjs', () => {
  it('is a dry run unless --apply is given', () => {
    expect(parseArgs([]).apply).toBe(false);
    expect(parseArgs(['--apply', '--store', 'dahab']).apply).toBe(true);
    expect(parseArgs(['--store', 'dahab']).store).toBe('dahab');
  });

  it('rejects --store without a slug', () => {
    expect(parseArgs(['--store']).error).toMatch(/slug/);
    expect(parseArgs(['--store', '--apply']).error).toMatch(/slug/);
  });

  it('splits ids into chunks the service accepts (500)', () => {
    expect(CHUNK).toBe(500);
    const ids = Array.from({ length: 1201 }, (_, i) => String(i));
    expect(chunk(ids).map((c: string[]) => c.length)).toEqual([500, 500, 201]);
    expect(chunk([])).toEqual([]);
  });

  it('refuses a non-loopback database without --yes-production, before touching anything', async () => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://u:p@db.example.com:5432/x';
    try {
      expect(await main(['--apply'])).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });
});
