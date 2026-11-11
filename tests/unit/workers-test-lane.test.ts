import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error - plain .mjs script, no type declarations
import { allWorkersTests, fullLaneOnly, prLaneTests } from '../../scripts/ci/workers-test-lane.mjs';

const ROOT = join(__dirname, '../..');
const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');

// The PR lane used to be a hand-maintained file list in ci.yml; every PR that added a test edited the same line and
// re-conflicted. The lane is now discovered, and this pins the orphan guarantee: every workerd test file runs somewhere.
describe('workerd test lanes are discovered, never listed', () => {
  it('ci.yml names no workers-test file; the PR lane comes from the discovery script', () => {
    expect(ci).not.toMatch(/workers-test\/[\w./-]+\.test\.ts/);
    expect(ci).toContain('$(node scripts/ci/workers-test-lane.mjs)');
  });
  it('the full lane passes no file arguments, so it runs every workers-test file', () => {
    expect(ci).toMatch(/\n\s+npm run cf:test -w apps\/api\n/);
    const cfg = readFileSync(join(ROOT, 'apps/api/vitest.workers.config.mts'), 'utf8');
    expect(cfg).toContain("include: ['workers-test/**/*.test.ts']");
  });
  it('every workerd test is in the PR lane or declared full-lane-only (none is orphaned)', () => {
    const all = allWorkersTests();
    const pr = new Set(prLaneTests());
    const only = new Set(fullLaneOnly());
    expect(all.length).toBeGreaterThan(20);
    for (const f of all) expect(pr.has(f) || only.has(f), f).toBe(true);
    expect([...pr].filter(f => only.has(f))).toEqual([]);
  });
  it('every full-lane-only entry is a real file (a stale entry would silently shrink nothing)', () => {
    for (const f of fullLaneOnly()) expect(existsSync(join(ROOT, 'apps/api', f)), f).toBe(true);
  });
  it('a new test file lands in the PR lane with no list edit', () => {
    expect(prLaneTests()).toContain('workers-test/tenant-isolation.test.ts');
  });
});
