/**
 * Flip-gate guard (INFRA-CF-1 PR D2b-4, Ruling CF-FINAL-1): no code path may refuse a Durable Object store (HTTP 501,
 * `*_NOT_ON_DO`) unless `docs/cf/not-on-do.json` lists it, and everything listed must still exist. The gate to flip a store
 * opens only when that file holds no refusal and no Postgres-only flow (`node scripts/cf/not-on-do.mjs` exits 0).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain ESM script shared with the CLI
import {
  findRefusals,
  scan,
  readManifest,
  gateState,
  jobRefusals,
} from '../../scripts/cf/not-on-do.mjs';

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
    expect(s.open).toBe(
      manifest.refusals.length === 0 &&
        manifest.postgresOnly.length === 0 &&
        manifest.jobsRefused.length === 0 &&
        manifest.jobsAccepted.length === 0 &&
        manifest.sweepSkips.length === 0
    );
    expect(gateState({ refusals: [], postgresOnly: [] }).open).toBe(true);
    expect(gateState({ refusals: [{}], postgresOnly: [] }).open).toBe(false);
    expect(gateState({ refusals: [], postgresOnly: [{}] }).open).toBe(false);
  });
});

describe('job refusals and sweep skips are part of the gate (Ruling CF-JOBS-4)', () => {
  const manifest = readManifest();
  const live = jobRefusals();

  it('the manifest lists exactly the jobs the runtime refuses and the sweeps it skips', () => {
    expect(manifest.jobsRefused).toEqual(live.jobsRefused);
    expect(manifest.jobsAccepted).toEqual(live.jobsAccepted);
    expect(manifest.sweepSkips).toEqual(live.sweepSkips);
    expect(live.moneyNotInMap).toEqual([]);
  });

  it('the gate is closed while any money job is refused or any sweep is skipped (negative controls)', () => {
    const base = {
      refusals: [],
      postgresOnly: [],
      jobsRefused: [],
      jobsAccepted: [],
      sweepSkips: [],
    };
    expect(gateState(base).open).toBe(true);
    expect(gateState({ ...base, jobsRefused: ['shipment-create'] }).open).toBe(false);
    expect(gateState({ ...base, sweepSkips: ['x'] }).open).toBe(false);
    // CF-JOBS-4: a refused non-money job closes the gate too
    const g = gateState({ ...base, jobsAccepted: ['review-request'] });
    expect(g.open).toBe(false);
    expect(g.jobsAccepted).toBe(1);
    // a manifest from before this ruling (no job fields) cannot silently open the gate over a refused job
    expect(live.jobsRefused.length === 0 || gateState(manifest).open === false).toBe(true);
  });

  it('jobRefusals sees a job that is neither none nor ported, and a cron sweep with no alarm', () => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'jobs-'));
    fs.writeFileSync(
      path.join(dir, 'job-data.ts'),
      `export const NO_STORE_DATA_JOBS: ReadonlySet<string> = new Set(['a']);
export const PORTED_JOBS: ReadonlySet<string> = new Set(['p']);
export const MONEY_JOBS: ReadonlySet<string> = new Set(['m']);`
    );
    fs.writeFileSync(
      path.join(dir, 'jobs-map.ts'),
      `export const JOBS_MAP = {
  a: { group: '1', kind: 'queue', trigger: 'cron' },
  p: { group: '1', kind: 'queue', trigger: 'cron' },
  m: { group: '7-money', kind: 'queue', trigger: 'event' },
  'x-other': { group: '1', kind: 'queue', trigger: 'event' },
};`
    );
    fs.writeFileSync(
      path.join(dir, 'alarm-flag.ts'),
      `export const ALARM_READY: ReadonlySet<string> = new Set([]);`
    );
    expect(jobRefusals(dir)).toEqual({
      jobsRefused: ['m'],
      jobsAccepted: ['x-other'],
      sweepSkips: ['p'],
      moneyNotInMap: [],
    });
  });
});
