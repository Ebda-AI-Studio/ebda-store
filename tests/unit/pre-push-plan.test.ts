/**
 * PREPUSH-1: the pre-push gate is planned from the changed files. A touched file runs its own tests; anything the
 * planner cannot narrow (lockfile, config, shared core) runs the full gate; docs-only runs only the cheap checks.
 */
import { describe, expect, it } from 'vitest';
import path, { join } from 'node:path';
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
});

// PREPUSH-2: the local gate is the UNIT tier only. A shared file pulled integration tests (they need the `test` role /
// test_db), so 71 files failed on the environment. The plan hands vitest an --exclude list and the gate applies it.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
// @ts-expect-error plain .mjs without types
import { PREPUSH_EXCLUDE } from '../../scripts/ci/pre-push-plan.mjs';

describe('pre-push plan: unit tier only (PREPUSH-2)', () => {
  const sharedFiles = [
    'apps/api/src/config/index.ts',
    'apps/api/src/middleware/security.ts',
    'apps/api/src/lib/jobs/schedule.ts',
    'apps/web/src/lib/api.ts',
  ];

  it.each(sharedFiles)(
    '%s: the plan carries the exclude list for integration, e2e and api-src tests',
    f => {
      const r = p(f);
      expect(r.exclude).toEqual(PREPUSH_EXCLUDE);
      for (const sample of [
        'tests/integration/refresh-token-rotation.test.ts',
        'tests/integration/auth-gdpr.test.ts',
        'tests/integration/warehouse/reconcile.test.ts',
        'tests/e2e/order.test.ts',
        'apps/api/src/services/foo.test.ts',
        'apps/api/workers-test/jobs.test.ts',
      ]) {
        const abs = `/repo/${sample}`;
        expect(
          PREPUSH_EXCLUDE.some((g: string) => path.matchesGlob(abs, g)),
          `${sample} must be excluded`
        ).toBe(true);
      }
      // and the unit tier is NOT excluded
      for (const unit of [
        'tests/unit/foo.test.ts',
        'apps/web/src/a.test.tsx',
        'packages/shared/src/b.test.ts',
      ]) {
        expect(PREPUSH_EXCLUDE.some((g: string) => path.matchesGlob(`/repo/${unit}`, g))).toBe(
          false
        );
      }
    }
  );

  it('behaviour: vitest related over a shared file runs the unit test and NOT the integration test', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prepush2-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      mkdirSync(join(dir, 'tests/unit'), { recursive: true });
      mkdirSync(join(dir, 'tests/integration'), { recursive: true });
      writeFileSync(join(dir, 'src/shared.ts'), 'export const x = 1;\n');
      const t = (name: string) =>
        `import { it, expect } from 'vitest';\nimport { x } from '../../src/shared';\nit('${name}', () => expect(x).toBe(1));\n`;
      writeFileSync(join(dir, 'tests/unit/a.test.ts'), t('UNIT_RAN'));
      writeFileSync(join(dir, 'tests/integration/b.test.ts'), t('INTEGRATION_RAN'));
      const bin = join(__dirname, '../../node_modules/.bin/vitest');
      const run = (extra: string[]) =>
        execFileSync(bin, ['related', '--run', '--reporter=verbose', ...extra, 'src/shared.ts'], {
          cwd: dir,
          encoding: 'utf8',
          env: { ...process.env, DATABASE_URL: 'postgresql://x:x@127.0.0.1:1/x' },
        });
      const out = run(PREPUSH_EXCLUDE.flatMap((g: string) => ['--exclude', g]));
      expect(out).toContain('UNIT_RAN');
      expect(out).not.toContain('INTEGRATION_RAN');
      // control: without the exclude list the same command DOES pull the integration test in
      expect(run([])).toContain('INTEGRATION_RAN');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
