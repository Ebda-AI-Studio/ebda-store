/** MQ-SCOPE-1: which merge groups may skip the heavy half of the full lane, and what the Merge queue gate accepts then. */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain .mjs without types
import {
  decideScope,
  DOCS_ONLY_SKIPPABLE_JOBS,
  HEAVY_ONLY_JOBS,
  isDocsOnly,
} from '../../scripts/ci/mq-scope.mjs';
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

describe('CI-CAPACITY-1: the marketing dry-run only runs for a group that can move it', () => {
  const marketing = (files: string[], labels: string[] = []) =>
    decideScope({ files, labels }).marketing;
  it('an API-only, admin-only or web-only group skips it', () => {
    expect(marketing(['apps/api/src/routes/store.routes.ts', 'tests/unit/x.test.ts'])).toBe(true); // a test file is a rail: strict
    expect(marketing(['apps/api/src/routes/store.routes.ts'])).toBe(false);
    expect(marketing(['apps/admin/src/app/page.tsx'])).toBe(false);
    expect(marketing(['apps/web/src/app/page.tsx', 'apps/api/src/a.ts'])).toBe(false);
  });
  it('marketing itself, and anything on a rail, runs it (strict: shared packages, root config, workflow, scripts, lockfile, tests)', () => {
    for (const f of [
      'apps/marketing/src/a.ts',
      'packages/shared/src/a.ts',
      'packages/database/src/a.ts',
      'packages/repo/src/a.ts',
      'package.json',
      'package-lock.json',
      'tsconfig.base.json',
      '.github/workflows/ci.yml',
      'scripts/ci/mq-scope.mjs',
      'tests/unit/a.test.ts',
      'apps/api/migrations/0001.sql',
    ])
      expect(marketing(['apps/api/src/a.ts', f]), f).toBe(true);
  });
  it('fails closed: the ci:full label and an empty diff never skip it', () => {
    expect(marketing(['apps/api/src/a.ts'], ['ci:full'])).toBe(true);
    expect(marketing([])).toBe(true);
  });
  it('the gate accepts a skipped worker-dry-run only when marketing=false, and never a failed one', () => {
    const ids = ['guards', 'worker-dry-run', 'security'];
    const n = (dry: string) =>
      Object.fromEntries(ids.map(i => [i, { result: i === 'worker-dry-run' ? dry : 'success' }]));
    expect(verdict('merge_group', n('skipped'), { heavy: 'true', marketing: 'false' }).ok).toBe(
      true
    );
    expect(verdict('merge_group', n('skipped'), { heavy: 'true', marketing: 'true' }).ok).toBe(
      false
    );
    expect(verdict('merge_group', n('skipped'), { heavy: 'true' }).ok).toBe(false);
    expect(verdict('merge_group', n('failure'), { heavy: 'true', marketing: 'false' }).ok).toBe(
      false
    );
    expect(verdict('merge_group', n('cancelled'), { heavy: 'true', marketing: 'false' }).ok).toBe(
      false
    );
  });
  it('ci.yml: the dry-run waits on the scope output for a merge group only, and tested-tree exports it', () => {
    const ci = readFileSync(path.resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('marketing: ${{ steps.scope.outputs.marketing }}');
    expect(ci).toContain(
      "(github.event_name != 'merge_group' || needs.tested-tree.outputs.marketing != 'false')"
    );
  });
});

describe('ci.yml wiring', () => {
  const ci = readFileSync(path.resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
  const job = (id: string) =>
    ci.match(new RegExp(`\\n  ${id}:\\n([\\s\\S]*?)(?=\\n  [a-z0-9-]+:\\n|$)`))?.[1] ?? '';
  it('every heavy-only job carries the light-scope skip ITSELF (CRITICAL-PATH-1: none waits for Build to inherit it)', () => {
    for (const id of HEAVY_ONLY_JOBS) {
      const j = job(id);
      expect(j, id).toContain("needs.tested-tree.outputs.heavy != 'false'");
      expect(j, id).toContain("needs.tested-tree.outputs.skip != 'true'");
    }
  });
  it('CRITICAL-PATH-1: Integration, E2E, Builder E2E and Orphan tests do NOT need Build (they build what they use) and start with the unit shards', () => {
    for (const id of ['test-integration', 'test-e2e', 'builder-e2e', 'orphan-tests']) {
      const j = job(id);
      expect(j, id).toMatch(/\n {4}needs: \[tested-tree(, changes)?\]/);
      expect(j, id).not.toMatch(/needs: \[[^\]]*\bbuild\b/);
      expect(j, id).not.toContain('needs.build.');
      // none of them downloads an artifact Build produced
      expect(j, id).not.toContain('download-artifact');
    }
  });
  it('CRITICAL-PATH-1: the two longest jobs run as 2 shards that together cover everything', () => {
    const integ = job('test-integration');
    expect(integ).toContain('shard: [1, 2]');
    expect(integ).toContain("SHARDS: '2'");
    expect(integ).toContain('--shard="$SHARD/$SHARDS"'); // the parallel pass
    expect(integ).toContain('scripts/ci/shard-lines.sh "$SHARD" "$SHARDS"'); // the serial planner lane
    const builder = job('builder-e2e');
    expect(builder).toContain('shard: [1, 2]');
    expect(builder).toContain('--shard=${{ matrix.shard }}/2');
  });
  it('the workerd dry-run is skipped by a STRICT docs-only scope only, and the gate is told', () => {
    const j = job('worker-dry-run');
    expect(j).toContain("needs.tested-tree.outputs.docs_only != 'true'");
    expect(job('tested-tree')).toContain('docs_only: ${{ steps.scope.outputs.docs_only }}');
  });
  it('the gate reads the scope from tested-tree', () => {
    expect(ci).toMatch(/\n {2}merge-queue-gate:[\s\S]*?\n {8}tested-tree,/);
  });
});

describe('strict docs-only scope (CRITICAL-PATH-1)', () => {
  it.each([
    [['docs/plans/a.md'], true],
    [['README.md', 'docs/rulings/X.md', 'docs/api/route-inventory.md'], true],
    [['docs/plans/a.md', 'apps/api/src/x.ts'], false], // one code file: full tier
    [['docs/plans/a.md', 'apps/marketing/src/a.ts'], false], // light workspace is NOT docs-only (its dry-run must run)
    [['docs/plans/a.md', '.github/workflows/ci.yml'], false],
    [['docs/plans/a.md', 'package.json'], false],
    [['docs/plans/a.md', 'scripts/ci/x.mjs'], false],
    [['docs/plans/a.md', 'tests/unit/a.test.ts'], false],
    [['docs/x.sql'], false], // a rail file never counts as a doc
    [['scripts/README.md'], false], // a markdown file under a rail is not trusted either
    [['.vscode/settings.json'], false],
    [['.editorconfig'], false],
    [[], false],
    [[''], false],
  ])('%j -> docsOnly %s', (files, expected) => {
    expect(isDocsOnly(files)).toBe(expected);
  });
  it('a docs-only diff skips the heavy tier AND is flagged; a mixed diff is the full tier', () => {
    expect(decideScope({ files: ['docs/plans/a.md', 'a.md'] })).toMatchObject({
      heavy: false,
      docsOnly: true,
    });
    expect(decideScope({ files: ['docs/plans/a.md', 'apps/api/src/x.ts'] })).toMatchObject({
      heavy: true,
      docsOnly: false,
    });
    expect(decideScope({ files: ['docs/plans/a.md'], labels: ['ci:full'] })).toMatchObject({
      heavy: true,
      docsOnly: false,
    });
    // light-workspace-only (not docs): heavy jobs skipped, but the dry-run is NOT
    expect(decideScope({ files: ['apps/marketing/src/a.ts'] })).toMatchObject({
      heavy: false,
      docsOnly: false,
    });
  });
  const ids = [
    'guards',
    'api-workerd-smoke',
    'worker-dry-run',
    'test-unit',
    'security',
    'tested-tree',
    ...HEAVY_ONLY_JOBS,
  ];
  const needs = (skipped: string[]) =>
    Object.fromEntries(ids.map(i => [i, { result: skipped.includes(i) ? 'skipped' : 'success' }]));
  it('the gate accepts a skipped dry-run only for a strictly docs-only group', () => {
    const skipped = [...HEAVY_ONLY_JOBS, ...DOCS_ONLY_SKIPPABLE_JOBS];
    expect(verdict('merge_group', needs(skipped), { heavy: 'false', docsOnly: 'true' }).ok).toBe(
      true
    );
    expect(verdict('merge_group', needs(skipped), { heavy: 'false', docsOnly: 'false' }).ok).toBe(
      false
    );
    expect(verdict('merge_group', needs(skipped), { heavy: 'false' }).ok).toBe(false);
    expect(verdict('merge_group', needs(skipped), { heavy: 'true', docsOnly: 'true' }).ok).toBe(
      false
    ); // docs_only without heavy=false is never trusted
    expect(verdict('merge_group', needs(skipped), { docsOnly: 'true' }).ok).toBe(false);
  });
  it('a docs-only group still needs the always-on jobs green (unit shards, security, guards, smoke)', () => {
    const skipped = [...HEAVY_ONLY_JOBS, ...DOCS_ONLY_SKIPPABLE_JOBS, 'test-unit'];
    expect(verdict('merge_group', needs(skipped), { heavy: 'false', docsOnly: 'true' }).ok).toBe(
      false
    );
  });
});

describe('scripts/ci/shard-lines.sh', () => {
  const run = (shard: string, shards: string, input: string) =>
    execFileSync(
      'bash',
      [path.resolve(__dirname, '../../scripts/ci/shard-lines.sh'), shard, shards],
      { input, encoding: 'utf8' }
    );
  const lines =
    Array.from({ length: 11 }, (_, i) => `tests/integration/f${i}.test.ts`).join('\n') + '\n';
  it('the shards are disjoint and together complete (nothing is run twice or dropped)', () => {
    for (const n of [2, 3]) {
      const parts = Array.from({ length: n }, (_, k) =>
        run(String(k + 1), String(n), lines)
          .split('\n')
          .filter(Boolean)
      );
      const all = parts.flat();
      expect(new Set(all).size).toBe(all.length);
      expect([...all].sort()).toEqual(lines.split('\n').filter(Boolean).sort());
    }
  });
  it('an empty lane gives every shard nothing, and a bad shard number is refused', () => {
    expect(run('1', '2', '')).toBe('');
    expect(() => run('3', '2', lines)).toThrow();
    expect(() => run('0', '2', lines)).toThrow();
    expect(() => run('a', '2', lines)).toThrow();
  });
});
