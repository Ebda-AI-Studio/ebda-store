/**
 * Ruling ITEST-13: planner / index tests run in their own SERIAL lane, derived from the helper import.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const lane = (arg: string) =>
  execFileSync('bash', [path.join(ROOT, 'scripts/ci/planner-lane.sh'), arg], { encoding: 'utf8' });

describe('planner lane', () => {
  it('lists every integration file that imports the app-role planner helper, and nothing else', () => {
    const files = lane('list').trim().split('\n');
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const f of files) {
      expect(f).toMatch(/^tests\/integration\/.+\.test\.ts$/);
      expect(readFileSync(path.join(ROOT, f), 'utf8')).toMatch(
        /app-role-planner|idle in transaction/
      );
    }
    expect(files).toContain('tests/integration/search-lexical-rls-index.test.ts');
    expect(files).toContain('tests/integration/customers-search-sql.test.ts');
    expect(files).toContain('tests/integration/payment-outage-isolation.test.ts');
    expect(files).toContain('tests/integration/payment-scope-and-events.test.ts');
  });

  it('excludes exactly those files from the parallel pass', () => {
    const files = lane('list').trim().split('\n');
    const ex = lane('excludes')
      .trim()
      .split(' --exclude ')
      .map(x => x.replace(/^--exclude /, ''));
    expect(ex.sort()).toEqual([...files].sort());
  });

  it('ci.yml runs the parallel pass without them and the lane serially afterwards', () => {
    const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('$PLANNER_EXCLUDES');
    expect(ci).toContain('lane="$(bash scripts/ci/planner-lane.sh list)"');
    expect(ci).toMatch(/npx vitest run \$lane --no-file-parallelism/);
    const parallel = ci.indexOf('npx vitest run $targets');
    const serial = ci.indexOf('--no-file-parallelism');
    expect(parallel).toBeGreaterThan(-1);
    expect(serial).toBeGreaterThan(parallel);
  });
});
