/**
 * #227 (2026-10-25) edited four Postgres integration test files and merged without ever running them: the PR lane does
 * not run the integration tier, and the planner never asked for it. integrationPlan() in scripts/ci-affected.mjs now
 * decides, and ci.yml's `Integration Tests` job runs on a PR exactly when it says so.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
// @ts-expect-error - plain .mjs script, no type declarations
import { integrationPlan } from '../../scripts/ci-affected.mjs';

const ROOT = join(__dirname, '../..');

/** A small repo tree with integration tests that import services the way the real ones do. */
function fixtureRoot(extraTests = 0) {
  const root = mkdtempSync(join(tmpdir(), 'ia-'));
  const put = (rel: string, body: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  put('apps/api/src/services/carriers/carrier.service.ts', 'export const a = 1;\n');
  put('apps/api/src/services/orders/index.ts', 'export const o = 1;\n');
  put('apps/api/src/routes/shipping.routes.ts', 'export const r = 1;\n');
  put('apps/api/src/services/unrelated.service.ts', 'export const u = 1;\n');
  put(
    'tests/integration/shipping.test.ts',
    "import { a } from '@api/services/carriers/carrier.service';\nimport r from '../../apps/api/src/routes/shipping.routes';\n"
  );
  put(
    'tests/integration/orders.test.ts',
    "import { o } from '@api/services/orders';\nvi.mock('@api/services/carriers/carrier.service');\n"
  );
  put('tests/integration/standalone.test.ts', "import { describe } from 'vitest';\n");
  put('tests/integration/helpers/fixture.ts', 'export const f = 1;\n');
  for (let i = 0; i < extraTests; i++)
    put(
      `tests/integration/many${i}.test.ts`,
      "import { u } from '@api/services/unrelated.service';\n"
    );
  return root;
}

describe('integrationPlan', () => {
  const root = fixtureRoot();

  it('a changed integration test file runs exactly that file (the #227 case)', () => {
    expect(integrationPlan(['tests/integration/shipping.test.ts'], root)).toEqual({
      integration: true,
      paths: ['tests/integration/shipping.test.ts'],
    });
  });

  it('several changed integration tests run exactly those', () => {
    const r = integrationPlan(
      ['tests/integration/shipping.test.ts', 'tests/integration/standalone.test.ts'],
      root
    );
    expect(r.paths).toEqual([
      'tests/integration/shipping.test.ts',
      'tests/integration/standalone.test.ts',
    ]);
  });

  it('a changed service runs the integration tests that import it (alias, relative and vi.mock imports)', () => {
    expect(
      integrationPlan(['apps/api/src/services/carriers/carrier.service.ts'], root).paths
    ).toEqual(['tests/integration/orders.test.ts', 'tests/integration/shipping.test.ts']);
    expect(integrationPlan(['apps/api/src/routes/shipping.routes.ts'], root).paths).toEqual([
      'tests/integration/shipping.test.ts',
    ]);
  });

  it('a directory import resolves to its index file', () => {
    expect(integrationPlan(['apps/api/src/services/orders/index.ts'], root).paths).toEqual([
      'tests/integration/orders.test.ts',
    ]);
  });

  it('a source file no integration test imports does not trigger the tier', () => {
    expect(integrationPlan(['apps/api/src/services/unrelated.service.ts'], root)).toEqual({
      integration: false,
      paths: [],
    });
  });

  it('a deleted integration test is never selected; an all-deleted change plans nothing (job skips)', () => {
    // standalone.test.ts exists in the fixture tree; gone.test.ts does not (the PR deleted it)
    expect(
      integrationPlan(
        ['tests/integration/gone.test.ts', 'tests/integration/standalone.test.ts'],
        root
      )
    ).toEqual({ integration: true, paths: ['tests/integration/standalone.test.ts'] });
    expect(
      integrationPlan(['tests/integration/gone.test.ts', 'tests/integration/gone2.test.ts'], root)
    ).toEqual({ integration: false, paths: [] });
  });

  it('a shared fixture/helper, snapshot, or anything under packages/database runs the whole tier', () => {
    for (const f of [
      'tests/integration/helpers/fixture.ts',
      'tests/integration/__snapshots__/x.snap',
      'tests/helpers/bundle-fixtures.ts',
      'packages/database/prisma/schema.prisma',
      'packages/database/prisma/migrations/20261101000000_x/migration.sql',
    ])
      expect(integrationPlan([f], root), f).toEqual({ integration: true, paths: 'all' });
  });

  it('docs-only and unrelated changes never trigger it', () => {
    expect(
      integrationPlan(
        ['docs/x.md', 'README.md', 'apps/web/src/a.tsx', 'apps/admin/src/b.tsx'],
        root
      )
    ).toEqual({
      integration: false,
      paths: [],
    });
  });

  it('more than 40 affected files collapses to "all"', () => {
    const big = fixtureRoot(45);
    const r = integrationPlan(['apps/api/src/services/unrelated.service.ts'], big);
    expect(r).toEqual({ integration: true, paths: 'all' });
  });

  it('on the REAL tree: the four files #227 touched are selected, and so is a service they import', () => {
    const four = [
      'tests/integration/provider-activation.test.ts',
      'tests/integration/provider-connect-routes.test.ts',
      'tests/integration/shipping-carrier-connect-routes.test.ts',
      'tests/integration/shipping-sp7.test.ts',
    ];
    expect(integrationPlan(four, ROOT)).toEqual({ integration: true, paths: four });
    const viaService = integrationPlan(['apps/api/src/services/shipping-carrier.service.ts'], ROOT);
    expect(viaService.integration).toBe(true);
    expect(viaService.paths).toContain('tests/integration/shipping-sp7.test.ts');
  });

  it('the planner CLI emits the two outputs ci.yml reads', () => {
    const files = ['tests/integration/shipping-sp7.test.ts'];
    const lines = classifyOutputs(files);
    expect(lines).toContain('integration=true');
    expect(lines).toContain('integration_paths=tests/integration/shipping-sp7.test.ts');
  });
});

// run the real CLI for the output contract
import { execFileSync } from 'node:child_process';
function classifyOutputs(files: string[]) {
  return execFileSync('node', [join(ROOT, 'scripts/ci-affected.mjs'), '--files', files.join(',')], {
    encoding: 'utf8',
  }).split('\n');
}
