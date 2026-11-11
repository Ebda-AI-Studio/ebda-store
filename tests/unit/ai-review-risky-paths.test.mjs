import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { isRisky, riskyPaths } from '../../.github/ai-review/risky-paths.mjs';

describe('ai-review classifier (fail closed: only docs, markdown and NEWLY ADDED tests are exempt)', () => {
  it('exempts markdown and docs/ whatever the status', () => {
    for (const p of ['README.md', 'docs/plans/x.md', 'docs/img/a.png']) for (const st of ['A', 'M', 'D']) expect(isRisky(p, st), `${st} ${p}`).toBe(false);
  });
  it('exempts a newly ADDED test file', () => {
    for (const p of ['apps/api/src/refunds/refund.test.ts', 'apps/api/test/helpers.ts', 'e2e/checkout.spec.ts']) expect(isRisky(p, 'A'), p).toBe(false);
  });
  it('a MODIFIED, DELETED or unknown-status test is risky: this repo\'s safety guards are test files', () => {
    const guards = readdirSync('tests/unit').filter((f) => /^(across-stores-isolation|no-rls-bypass-in-runtime|no-raw-pii-in-logs)/.test(f));
    expect(guards.length).toBeGreaterThan(0);
    for (const f of guards) for (const st of ['M', 'D', '?']) expect(isRisky(`tests/unit/${f}`, st), `${st} ${f}`).toBe(true);
  });
  it('requires review for data and money paths of this repo', () => {
    for (const p of ['packages/database/src/index.ts', 'packages/database/prisma/schema.prisma', 'apps/api/src/routes/order.routes.ts', 'apps/api/src/services/order.service.ts', 'apps/api/src/services/cross-store.service.ts']) expect(isRisky(p, 'A'), p).toBe(true);
  });
  it('requires review for the gate itself and CI, so the gate cannot be edited to pass', () => {
    for (const p of ['.github/ai-review/review.mjs', '.github/ai-review/prompt.md', '.github/workflows/ai-review.yml', 'scripts/ci/merge-gate.sh', 'package.json']) expect(isRisky(p, 'A'), p).toBe(true);
  });
  it('does not let a docs/ or test-looking name smuggle code through', () => {
    for (const p of ['docs/build.mjs', 'apps/api/src/contest.ts', 'apps/api/src/test-utils.ts']) expect(isRisky(p, 'A'), p).toBe(true);
  });
  it('parses git --name-status lines', () => {
    expect(riskyPaths(['A\tREADME.md', 'A\ta.test.ts', ''])).toEqual([]);
    expect(riskyPaths(['M\ttests/guard.test.ts', 'A\ttests/new.test.ts', 'A\tapps/api/src/x.ts'])).toEqual(['tests/guard.test.ts', 'apps/api/src/x.ts']);
  });
  it('the workflow: base checkout, 400 KB fails, name-status, fork-gate red until labelled', () => {
    const wf = readFileSync('.github/workflows/ai-review.yml', 'utf8');
    expect((wf.match(/ref: \$\{\{ github\.event\.pull_request\.base\.ref \}\}/g) ?? []).length).toBe(2);
    expect(wf).not.toMatch(/head -c/);
    expect(wf).toMatch(/-ge 400000/);
    expect(wf).toMatch(/git diff --name-status --no-renames/);
    const fork = wf.slice(wf.indexOf('  fork-gate:'));
    expect(fork).toMatch(/head\.repo\.full_name != github\.repository/);
    expect(fork).toMatch(/exit 1/);
    expect(fork).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
  });
});
