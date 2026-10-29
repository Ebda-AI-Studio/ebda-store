/**
 * Flip-gate guard (INFRA-CF-1 PR D2b-4, Ruling CF-FINAL-1): no code path may refuse a Durable Object store (HTTP 501,
 * `*_NOT_ON_DO`) unless `docs/cf/not-on-do.json` lists it, and everything listed must still exist. The gate to flip a store
 * opens only when that file holds no refusal and no Postgres-only flow (`node scripts/cf/not-on-do.mjs` exits 0).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain ESM script shared with the CLI
import { findRefusals, scan, readManifest, gateState } from '../../scripts/cf/not-on-do.mjs';

const ROOT = path.resolve(__dirname, '../..');
type Found = { code: string; line: number; file: string };

describe('findRefusals (negative controls)', () => {
  it('sees a 501 error, a *_NOT_ON_DO literal and a status: 501 object, however they are spelled', () => {
    expect(
      findRefusals(`throw new AppError(501, 'FOO_NOT_ON_DO', 'x');`).map((r: Found) => r.code)
    ).toEqual(['FOO_NOT_ON_DO']);
    expect(
      findRefusals(`throw new AppError(\n 501,\n 'BAR',\n 'x');`).map((r: Found) => r.code)
    ).toEqual(['BAR']);
    expect(
      findRefusals(`throw new MoneyError('BAZ', 'x', 501);`).map((r: Found) => r.code)
    ).toEqual(['BAZ']);
    expect(findRefusals(`const r = { ok: false, status: 501 };`).map((r: Found) => r.code)).toEqual(
      ['501']
    );
    expect(findRefusals(`const M = { QUOTE_NOT_ON_DO: [501] };`)).toHaveLength(0); // a key, not a string literal
    expect(findRefusals(`const c = 'ORDER_STATUS_NOT_ON_DO';`).map((r: Found) => r.code)).toEqual([
      'ORDER_STATUS_NOT_ON_DO',
    ]);
  });
  it('ignores 500 and 5010 and prose that merely mentions the words', () => {
    expect(
      findRefusals(`throw new AppError(500, 'X', 'y'); const n = 5010; // not on do (501)`)
    ).toHaveLength(0);
  });
});

describe('the refusal inventory equals the manifest', () => {
  const found: Found[] = scan();
  const manifest = readManifest();

  it('every refusal in the code is listed (a new 501 / NOT_ON_DO fails until it is listed or removed)', () => {
    const listed = new Set(manifest.refusals.map((r: { code: string }) => r.code));
    const unlisted = found
      .filter(f => !listed.has(f.code))
      .map(f => `${f.file}:${f.line} ${f.code}`);
    expect(unlisted).toEqual([]);
  });

  it('every listed refusal still exists in the named file (a closed one must be removed from the manifest)', () => {
    const stale = manifest.refusals
      .filter(
        (r: { code: string; file: string }) =>
          !found.some(f => f.code === r.code && f.file === r.file)
      )
      .map((r: { code: string }) => r.code);
    expect(stale).toEqual([]);
    for (const r of manifest.refusals as Array<{ file: string }>)
      expect(fs.existsSync(path.join(ROOT, r.file))).toBe(true);
  });

  it('the gate is closed exactly while something is listed', () => {
    const s = gateState(manifest);
    expect(s.open).toBe(manifest.refusals.length === 0 && manifest.postgresOnly.length === 0);
    expect(gateState({ refusals: [], postgresOnly: [] }).open).toBe(true);
    expect(gateState({ refusals: [{}], postgresOnly: [] }).open).toBe(false);
    expect(gateState({ refusals: [], postgresOnly: [{}] }).open).toBe(false);
  });
});
