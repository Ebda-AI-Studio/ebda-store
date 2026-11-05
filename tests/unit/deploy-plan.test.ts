/**
 * Ruling CI-BUDGET-2: a push starts only the deploys whose app can have changed. Runs the real `paths:` of every
 * cf-<app>-deploy.yml through scripts/ci/deploy-plan.mjs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain .mjs without types
import {
  planDeploy,
  triggerPaths,
  lockClosure,
  lockAffects,
  wantsForce,
} from '../../scripts/ci/deploy-plan.mjs';

const WF = path.resolve(__dirname, '../../.github/workflows');
const apps = readdirSync(WF)
  .map(f => /^cf-(.+)-deploy\.yml$/.exec(f)?.[1])
  .filter((a): a is string => Boolean(a));
const pathsOf = (app: string) =>
  triggerPaths(readFileSync(path.join(WF, `cf-${app}-deploy.yml`), 'utf8'));
const deploys = (files: string[], extra: Record<string, unknown> = {}) =>
  apps.filter(a => planDeploy({ paths: pathsOf(a), files, ...extra }).deploy).sort();

describe('deploy-plan: which apps a push deploys', () => {
  it('reads real trigger paths for every deploy workflow (not an empty-set pass)', () => {
    expect(apps.length).toBeGreaterThanOrEqual(9);
    for (const a of apps) expect(pathsOf(a).length, a).toBeGreaterThan(0);
  });

  it('a deploy workflow edit alone deploys nothing (config-only)', () => {
    for (const a of apps) expect(deploys([`.github/workflows/cf-${a}-deploy.yml`])).toEqual([]);
    expect(deploys(apps.map(a => `.github/workflows/cf-${a}-deploy.yml`))).toEqual([]);
  });

  it('[force-deploy] / workflow_dispatch deploys even a workflow-only edit', () => {
    expect(
      planDeploy({
        paths: pathsOf('web'),
        files: ['.github/workflows/cf-web-deploy.yml'],
        force: true,
      }).deploy
    ).toBe(true);
  });

  it('[force-deploy] forces only in the commit subject, never in the body', () => {
    expect(wantsForce('ci: redeploy web [force-deploy]\n\nbody')).toBe(true);
    expect(wantsForce('fix: x\n\nbody\n\n[force-deploy]\nCo-Authored-By: a')).toBe(false);
    expect(
      wantsForce('ci: a push deploys\n\nworkflow_dispatch and [force-deploy] always deploy.')
    ).toBe(false);
    expect(wantsForce('fix: plain subject')).toBe(false);
  });

  it('an app code edit deploys that app only', () => {
    expect(deploys(['apps/web/src/app/page.tsx'])).toEqual(['web']);
    expect(deploys(['apps/admin/src/x.ts'])).toEqual(['admin']);
    expect(deploys(['apps/accounts/src/x.ts'])).toEqual(['accounts']);
  });

  it('a shared package edit deploys only the apps that are built from it', () => {
    const r = deploys(['packages/shared/src/money.ts']);
    expect(r).toEqual(expect.arrayContaining(['web', 'admin', 'orders', 'marketing', 'api']));
    expect(r).not.toContain('accounts');
    expect(r).not.toContain('status'); // status takes only packages/shared/src/brand/**
    expect(deploys(['packages/shared/src/brand/names.ts'])).toContain('status');
    expect(deploys(['packages/ui/src/button.tsx'])).not.toContain('marketing');
  });

  it('a shared build script deploys only the apps whose build runs it', () => {
    expect(deploys(['scripts/cf-build.sh'])).toEqual(['admin', 'orders', 'web']);
    expect(deploys(['scripts/ci/assert-web-middleware.mjs'])).toEqual([]);
  });

  it('the deploy gate itself is not a bundle input', () => {
    expect(deploys(['scripts/ci/deploy-guard.mjs', 'scripts/ci/workerd-smoke.mjs'])).toEqual([]);
  });

  it('tests, docs and other repo files deploy nothing', () => {
    expect(
      deploys(['tests/unit/x.test.ts', 'docs/README.md', 'AGENTS.md', 'vitest.config.ts'])
    ).toEqual([]);
  });
});

describe('deploy-plan: package-lock.json', () => {
  const entry = (deps: Record<string, string> = {}, version = '1.0.0') => ({
    version,
    dependencies: deps,
  });
  const lock = (over: Record<string, unknown> = {}) => ({
    packages: {
      '': { workspaces: ['apps/*', 'packages/*'] },
      'apps/web': { dependencies: { '@ebda/shared': '*', pkgweb: '1' } },
      'apps/accounts': { dependencies: { pkgacc: '1' } },
      'packages/shared': { dependencies: { common: '1' } },
      'node_modules/@ebda/shared': { resolved: 'packages/shared', link: true },
      'node_modules/pkgweb': entry({ nested: '1' }),
      'node_modules/nested': entry(),
      'node_modules/pkgacc': entry(),
      'node_modules/common': entry(),
      ...over,
    },
  });
  const run = (after: ReturnType<typeof lock>) =>
    deploys(['package-lock.json'], { readLocks: () => ({ before: lock(), after }) });

  it('the closure follows workspace links and nested dependencies', () => {
    const c = lockClosure(lock(), ['apps/web']);
    expect([...c]).toEqual(
      expect.arrayContaining(['node_modules/pkgweb', 'node_modules/nested', 'node_modules/common'])
    );
    expect(c.has('node_modules/pkgacc')).toBe(false);
  });

  it('a bump of a dependency only one app uses deploys only that app', () => {
    const after = lock({ 'node_modules/pkgacc': entry({}, '2.0.0') });
    const plan = (app: string) =>
      planDeploy({
        paths: [`apps/${app}/**`, 'package-lock.json'],
        files: ['package-lock.json'],
        readLocks: () => ({ before: lock(), after }),
      }).deploy;
    const r = ['web', 'accounts'].filter(plan);
    expect(r).toEqual(['accounts']);
    expect(lockAffects(lock(), after, [/^apps\/web\//])).toBeNull();
    expect(
      lockAffects(lock(), lock({ 'node_modules/nested': entry({}, '9.9.9') }), [/^apps\/web\//])
    ).toBe('node_modules/nested');
  });

  it('an unreadable lockfile diff fails open (deploys)', () => {
    const r = planDeploy({
      paths: pathsOf('web'),
      files: ['package-lock.json'],
      readLocks: () => {
        throw new Error('boom');
      },
    });
    expect(r.deploy).toBe(true);
    expect(run(lock())).toEqual([]);
  });
});

describe('every deploy workflow is gated by its plan job', () => {
  it.each(apps)('%s: deploy needs plan, and workflow_dispatch/main still deploys', app => {
    const text = readFileSync(path.join(WF, `cf-${app}-deploy.yml`), 'utf8');
    expect(text).toContain(`node scripts/ci/deploy-plan.mjs --app ${app} `);
    expect(text).toMatch(
      /\n {2}deploy:\n {4}needs: \[plan\]\n {4}if: github\.ref == 'refs\/heads\/main' && needs\.plan\.outputs\.deploy == 'true'/
    );
    expect(text).toContain('workflow_dispatch:');
  });
});
