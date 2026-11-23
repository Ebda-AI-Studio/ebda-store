/** MQ-SCOPE-1: which merge groups may skip the heavy half of the full lane, and what the Merge queue gate accepts then. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain .mjs without types
import { decideScope, HEAVY_ONLY_JOBS } from '../../scripts/ci/mq-scope.mjs';
// @ts-expect-error plain .mjs without types
import { verdict } from '../../scripts/ci/merge-queue-gate.mjs';

const heavy = (files: string[], labels: string[] = []) => decideScope({ files, labels }).heavy;

describe('decideScope', () => {
  it('a sitemap / marketing-only change is light', () => {
    expect(heavy(['apps/marketing/src/app/sitemap.ts'])).toBe(false);
    expect(heavy(['apps/marketing/src/lib/page-lastmod.json', 'docs/x.md'])).toBe(false);
    expect(heavy(['docs/a.md'])).toBe(false);
  });
  it.each([
    'package-lock.json',
    'package.json',
    'packages/shared/src/a.ts',
    'packages/repo/src/a.ts',
    'packages/database/prisma/migrations/1/migration.sql',
    '.github/workflows/ci.yml',
    'scripts/ci/x.mjs',
    'scripts/ci-affected.mjs',
    'tests/unit/a.test.ts',
    'apps/api/src/cf/modules/help-corpus.mjs',
    'apps/web/src/a.tsx',
    'tsconfig.base.json',
  ])('rail / heavy workspace %s runs the full tier', f => {
    expect(heavy(['apps/marketing/src/a.ts', f])).toBe(true);
  });
  it('the ci:full label forces the full tier', () => {
    expect(heavy(['apps/marketing/src/a.ts'], ['ci:full'])).toBe(true);
  });
  it('an empty diff fails closed', () => {
    expect(heavy([])).toBe(true);
    expect(heavy([''])).toBe(true);
  });
});

describe('merge queue gate with a light merge group', () => {
  const ids = [
    'guards',
    'api-workerd-smoke',
    'worker-dry-run',
    'test-unit',
    'security',
    'tested-tree',
    ...HEAVY_ONLY_JOBS,
  ];
  const needs = (skipped: string[], extra: Record<string, unknown> = {}) =>
    Object.fromEntries(
      ids.map(i => [
        i,
        { result: skipped.includes(i) ? 'skipped' : 'success', ...(extra[i] as object) },
      ])
    );
  it('accepts skipped heavy-only jobs only when heavy=false', () => {
    expect(verdict('merge_group', needs(HEAVY_ONLY_JOBS), { heavy: 'false' }).ok).toBe(true);
    expect(verdict('merge_group', needs(HEAVY_ONLY_JOBS), { heavy: 'true' }).ok).toBe(false);
    expect(verdict('merge_group', needs(HEAVY_ONLY_JOBS)).ok).toBe(false);
  });
  it('never accepts a skipped always-on job, nor a failed heavy job', () => {
    expect(
      verdict('merge_group', needs([...HEAVY_ONLY_JOBS, 'security']), { heavy: 'false' }).ok
    ).toBe(false);
    const n = needs([]);
    (n as any)['test-e2e'] = { result: 'failure' };
    expect(verdict('merge_group', n, { heavy: 'false' }).ok).toBe(false);
  });
});

describe('ci.yml wiring', () => {
  const ci = readFileSync(path.resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
  it('every heavy-only job is skipped by a light scope (directly or through build)', () => {
    for (const id of ['build', 'workerd-integration'])
      expect(ci).toMatch(
        new RegExp(`\\n  ${id}:[\\s\\S]*?needs\\.tested-tree\\.outputs\\.heavy != 'false'`)
      );
  });
  it('the gate reads the scope from tested-tree', () => {
    expect(ci).toMatch(/\n {2}merge-queue-gate:[\s\S]*?\n {8}tested-tree,/);
  });
});
