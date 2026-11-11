import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isRisky, riskyPaths } from '../../.github/ai-review/risky-paths.mjs';

describe('ai-review classifier (fail closed: only docs/markdown/tests are exempt)', () => {
  it('exempts markdown, docs/, and test files', () => {
    for (const p of ['README.md', 'docs/plans/x.md', 'docs/img/a.png', 'apps/api/src/refunds/refund.test.ts', 'apps/api/test/helpers.ts', 'e2e/checkout.spec.ts']) expect(isRisky(p), p).toBe(false);
  });
  it('requires review for data and money paths of this repo', () => {
    for (const p of ['packages/database/src/index.ts', 'packages/database/prisma/schema.prisma', 'apps/api/src/routes/order.routes.ts', 'apps/api/src/services/order.service.ts', 'apps/api/src/services/cross-store.service.ts']) expect(isRisky(p), p).toBe(true);
  });
  it('requires review for the gate itself and CI, so the gate cannot be edited to pass', () => {
    for (const p of ['.github/ai-review/review.mjs', '.github/ai-review/prompt.md', '.github/workflows/ai-review.yml', 'scripts/ci/merge-gate.sh', 'package.json']) expect(isRisky(p), p).toBe(true);
  });
  it('does not let a docs/ or test-looking name smuggle code through', () => {
    for (const p of ['docs/build.mjs', 'apps/api/src/contest.ts', 'apps/api/src/test-utils.ts']) expect(isRisky(p), p).toBe(true);
  });
  it('reports only the paths that need review', () => {
    expect(riskyPaths(['README.md', 'a.test.ts'])).toEqual([]);
    expect(riskyPaths(['README.md', 'apps/api/src/x.ts', ''])).toEqual(['apps/api/src/x.ts']);
  });
  it('the workflow checks out the base branch in both jobs and fails on a 400 KB diff', () => {
    const wf = readFileSync('.github/workflows/ai-review.yml', 'utf8');
    expect((wf.match(/ref: \$\{\{ github\.event\.pull_request\.base\.ref \}\}/g) ?? []).length).toBe(2);
    expect(wf).not.toMatch(/head -c/);
    expect(wf).toMatch(/-ge 400000/);
  });
});
