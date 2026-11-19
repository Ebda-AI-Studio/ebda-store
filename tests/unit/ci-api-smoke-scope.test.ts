/**
 * PR-CI-CHEAP-1: the `API Worker boots on workerd` skip is conservative (skip only when EVERY changed file is on the
 * allowlist), its scope step needs no node_modules, and every step of the skippable job is gated on the scope output.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
// @ts-expect-error - plain .mjs script, no type declarations
import { apiSmokeInScope } from '../../scripts/ci/api-smoke-scope.mjs';

const ROOT = path.resolve(__dirname, '../..');
const ci = yaml.load(readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as any;

describe('api smoke scope (allowlist, fail-safe)', () => {
  it.each([
    [['docs/ebda/ci.md']],
    [['README.md', 'docs/a/b.png']],
    [['apps/web/src/x.tsx', 'apps/admin/src/y.ts', 'apps/marketing/a.ts', 'apps/help/a.ts']],
    [['apps/docs/a.md', 'apps/orders/src/a.ts']],
    [['tests/unit/foo.test.ts', 'docs/x.md']],
  ])('SKIPS when every file is allowlisted: %j', files => {
    expect(apiSmokeInScope(files).run).toBe(false);
  });

  it.each([
    [['apps/api/src/index.ts']],
    [['docs/x.md', 'apps/api/src/a.ts']],
    [['package.json']],
    [['package-lock.json']],
    [['tsconfig.base.json']],
    [['packages/shared/src/a.ts']],
    [['packages/repo/src/a.ts']],
    [['apps/web/wrangler.jsonc', 'apps/accounts/src/a.ts']],
    [['packages/database/prisma/schema.prisma']],
    [['scripts/ci/workerd-smoke.sh']],
    [['.github/workflows/ci.yml']],
    [['tests/integration/a.test.ts']],
    [['some/unknown/path.ts']],
    [['docs/x.md', 'wrangler.toml']],
  ])('RUNS when any file is not allowlisted: %j', files => {
    expect(apiSmokeInScope(files).run).toBe(true);
  });

  it('RUNS on an empty diff', () => {
    expect(apiSmokeInScope([]).run).toBe(true);
    expect(apiSmokeInScope(['', '  ']).run).toBe(true);
  });
});

describe('scripts that run before npm ci import only node: builtins', () => {
  it.each(['scripts/ci-affected.mjs', 'scripts/ci/api-smoke-scope.mjs'])('%s', file => {
    const src = readFileSync(path.join(ROOT, file), 'utf8');
    const specs = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map(m => m[1]);
    const dyn = [...src.matchAll(/(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of [...specs, ...dyn]) expect(s, `${file} imports ${s}`).toMatch(/^node:/);
  });
});

describe('api-workerd-smoke: every step after the scope decision is gated on it', () => {
  const steps = ci.jobs['api-workerd-smoke'].steps as any[];
  const scopeIdx = steps.findIndex(s => s.id === 'scope');
  it('has the scope step, preceded only by checkout, the private TMPDIR and setup-node', () => {
    expect(scopeIdx).toBeGreaterThan(0);
    for (const s of steps.slice(0, scopeIdx))
      expect(`${s.uses ?? ''} ${s.name ?? ''}`).toMatch(
        /actions\/(checkout|setup-node)@|Private TMPDIR/
      );
  });
  it('every later step reads steps.scope.outputs.run in its if', () => {
    const later = steps.slice(scopeIdx + 1);
    expect(later.length).toBeGreaterThan(3);
    for (const s of later)
      expect(String(s.if), s.name ?? s.run ?? s.uses).toContain(
        "steps.scope.outputs.run == 'true'"
      );
  });
  it('the job has no job-level if (it is a required check)', () => {
    expect(ci.jobs['api-workerd-smoke'].if).toBeUndefined();
  });
});

describe('PR unit job: whole-suite falls back to 3 shards, no hard-coded total', () => {
  const unit = ci.jobs.unit;
  it('shard list and total derive from changes.outputs.all', () => {
    expect(unit.strategy.matrix.shard).toContain("needs.changes.outputs.all == 'true'");
    expect(ci.jobs.changes.outputs.all).toBeDefined();
    const run = unit.steps.find((s: any) => String(s.run).includes('vitest run $UNIT_PATHS')).run;
    expect(run).toContain('/$UNIT_SHARDS');
    expect(run).not.toMatch(/--shard=\S*\/[0-9]/);
  });
});
