/**
 * PREPUSH-1: the pre-push gate is planned from the changed files. A touched file runs its own tests; anything the
 * planner cannot narrow (lockfile, config, shared core) runs the full gate; docs-only runs only the cheap checks.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error plain .mjs without types
import { plan } from '../../scripts/ci/pre-push-plan.mjs';
// @ts-expect-error plain .mjs without types
import { loadWorkspaces } from '../../scripts/ci-affected.mjs';

const ws = loadWorkspaces();
const p = (...f: string[]) => plan(f, ws);

describe('pre-push plan', () => {
  it('a touched source file runs the tests that import it, and lint/typecheck of its workspace only', () => {
    const r = p('apps/api/src/cf/ops/backup-sweep.ts');
    expect(r.mode).toBe('affected');
    expect(r.related).toContain('apps/api/src/cf/ops/backup-sweep.ts');
    expect(r.lint).toEqual(['-w apps/api']);
    expect(r.typecheck).toContain('apps/api/tsconfig.json');
    expect(r.typecheck).not.toContain('apps/web/tsconfig.json');
  });

  it('a touched test file runs itself', () => {
    const r = p('tests/unit/pre-push-plan.test.ts');
    expect(r.mode).toBe('affected');
    expect(r.related).toEqual(['tests/unit/pre-push-plan.test.ts']);
  });

  it.each([
    'package-lock.json',
    'package.json',
    'tsconfig.base.json',
    'vitest.config.ts',
    'packages/shared/src/x.ts',
    'packages/database/prisma/schema.prisma',
  ])('%s makes the planner fall back to the full suite', f => {
    const r = p(f);
    expect(r.mode).toBe('full');
    expect(r.related).toEqual([]);
  });

  it('a lockfile mixed into an otherwise narrow push still runs everything', () => {
    expect(p('apps/api/src/a.ts', 'package-lock.json').mode).toBe('full');
  });

  it('docs-only runs only the cheap checks', () => {
    const r = p('docs/RULINGS.md');
    expect(r.mode).toBe('docs');
    expect(r.related).toEqual([]);
    expect(r.lint).toEqual([]);
  });

  it('the gate script is wired to the plan, falls back to the full gate, and never takes the host lock itself', () => {
    const g = readFileSync(join(__dirname, '../../scripts/ci/pre-push-gate.sh'), 'utf8');
    expect(g).toContain('pre-push-plan.mjs');
    expect(g).toContain('vitest related');
    expect(g).toContain('gitleaks detect');
    expect(g).toContain('npm run test:unit');
    expect(g).not.toMatch(/^[^#\n]*host-lock\.sh/m);
  });
});
