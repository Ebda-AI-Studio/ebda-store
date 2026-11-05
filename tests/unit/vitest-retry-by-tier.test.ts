/**
 * #1248 — retry:1 as a global vitest default let a retry re-run ONLY the
 * failures of an order-dependent unit test against an already-drained mock
 * queue, going green while the attempt-1 failure was the real defect (five
 * bank-reconciliation tests, fixed 2026-09-02). That masking landed on the
 * required "Unit Tests" CI job, which runs the root config with no override,
 * so the next order-dependent unit test to slip in merges silently.
 *
 * This pins the fix: retry is 0 by DEFAULT (vitest.config.ts), the required
 * Unit Tests job either inherits that or says so explicitly, and only the
 * genuinely network/DB-backed tiers (integration, e2e) opt back into a
 * retry, at the invocation site, not the shared default.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');

describe('vitest retry is scoped by tier, not a global default', () => {
  it('vitest.config.ts defaults to no retry', () => {
    const cfg = readFileSync(path.join(ROOT, 'vitest.config.ts'), 'utf8');
    // Match the actual `retry:` setting, not a comment mentioning retry.
    const m = cfg.match(/^\s*retry:\s*(\d+)\s*,/m);
    expect(m, 'vitest.config.ts should set an explicit `retry:` value').toBeTruthy();
    expect(
      Number(m![1]),
      'a non-zero default retry re-runs ONLY the failures of an order-dependent ' +
        'unit test, masking state pollution on every job that uses this config ' +
        'without its own override'
    ).toBe(0);
  });

  it('the required Unit Tests job does not opt back into masking retries', () => {
    const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const unitRun = ci
      .split('\n')
      .find(l => l.includes('vitest run tests/unit packages/shared/src'));
    expect(unitRun, "ci.yml's main-lane unit command moved — re-point this test").toBeTruthy();
    expect(unitRun, 'the unit tier must never request retry > 0').not.toMatch(/--retry=[1-9]/);
    // The PR lane's affected-paths run is the same tier: also no masking retry.
    const prRun = ci.split('\n').find(l => l.includes('vitest run $UNIT_PATHS'));
    expect(prRun, "ci.yml's PR-lane unit command moved — re-point this test").toBeTruthy();
    expect(prRun, 'the PR unit tier must never request retry > 0').toMatch(/--retry=0(\s|$)/);
  });

  it('the network/DB-backed tiers explicitly opt into one retry at the call site', () => {
    const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');

    const integrationRun = ci.split('\n').find(l => l.includes('npx vitest run $targets'));
    // $targets is `tests/integration apps/api/src` in the main lane, or the planner-selected files on a PR (ci.yml)
    expect(ci).toContain('targets="tests/integration apps/api/src"');
    expect(integrationRun, "ci.yml's integration command moved — re-point this test").toBeTruthy();
    expect(
      integrationRun,
      'integration hits real Postgres/Redis service containers — it should opt into ' +
        'a retry explicitly rather than relying on a global default'
    ).toMatch(/--retry=1/);

    const e2eRun = ci.split('\n').find(l => l.includes('npm run test:e2e'));
    expect(e2eRun, "ci.yml's e2e command moved — re-point this test").toBeTruthy();
    expect(
      e2eRun,
      'e2e hits a real HTTP server + Postgres + Redis — it should opt into a retry ' +
        'explicitly rather than relying on a global default'
    ).toMatch(/--retry=1/);
  });
});
