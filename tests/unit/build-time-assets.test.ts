/**
 * Build-time assistant assets (docs/plans/2026-11-24-help-corpus-build-time.md): apps/api/src/cf/modules/help-corpus.mjs and
 * apps/api/src/smart-layer/registry.generated.json are generated, git-ignored outputs. Committed, nearly every PR that touched help content or a
 * capability conflicted on them as main moved. These pins keep them out of git AND keep every consumer generating them first.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain .mjs script, no type declarations
import { classify, loadWorkspaces } from '../../scripts/ci-affected.mjs';

const ROOT = path.resolve(__dirname, '../..');
const read = (f: string) => readFileSync(path.join(ROOT, f), 'utf8');
const ASSETS = [
  'apps/api/src/cf/modules/help-corpus.mjs',
  'apps/api/src/smart-layer/registry.generated.json',
];
const GEN = 'apps/api/scripts/build-help-corpus.mjs';

describe('the assistant assets are build outputs, not source', () => {
  it('neither file is tracked by git, and both are ignored (so a PR can never carry them)', () => {
    for (const f of ASSETS) {
      expect(
        execFileSync('git', ['ls-files', f], { cwd: ROOT, encoding: 'utf8' }).trim(),
        `${f} is tracked`
      ).toBe('');
      expect(
        spawnSync('git', ['check-ignore', '-q', f], { cwd: ROOT }).status,
        `${f} is not ignored`
      ).toBe(0);
    }
  });

  it('the generator ran for this test run (globalSetup) and the files are non-trivial: both locales, every capability', () => {
    for (const f of ASSETS)
      expect(existsSync(path.join(ROOT, f)), `${f} missing: globalSetup did not generate it`).toBe(
        true
      );
    const registry = JSON.parse(read(ASSETS[1]!)) as Array<{ id: string }>;
    expect(registry.length).toBeGreaterThan(20);
    const corpus = read(ASSETS[0]!);
    expect(corpus.startsWith('export default {"hash":"')).toBe(true);
    expect(corpus).toContain('"locale":"ar"');
    expect(corpus).toContain('"locale":"en"');
  });

  it('`--check` is the freshness check: exits 0 against the files the sources produce', () => {
    expect(
      spawnSync(process.execPath, [path.join(ROOT, GEN), '--check'], { cwd: ROOT }).status
    ).toBe(0);
  });
});

describe('every consumer generates the assets before using them', () => {
  it('wrangler build.command (deploy, dry-run, dev, Workers Builds) runs the generator in the api folder', () => {
    expect(read('apps/api/wrangler.jsonc')).toMatch(
      /"build":\s*\{\s*"command":\s*"node scripts\/build-help-corpus\.mjs"\s*\}/
    );
  });

  it('every vitest config that can import the registry has the globalSetup', () => {
    for (const f of [
      'vitest.config.ts',
      'vitest.stryker.config.ts',
      'apps/api/vitest.workers.config.mts',
      'apps/api/vitest.workers-do.config.mts',
    ])
      expect(read(f), f).toContain('global-setup-assistant-assets.ts');
  });

  it('npm scripts: root typecheck, and apps/api dev / build / lint / test', () => {
    const root = JSON.parse(read('package.json')).scripts;
    expect(root.pretypecheck).toContain('build-help-corpus.mjs');
    const api = JSON.parse(read('apps/api/package.json')).scripts;
    for (const k of ['predev', 'prebuild', 'prelint', 'pretest'])
      expect(api[k], k).toContain('build-help-corpus.mjs');
  });

  it('CI: the npm-ci composite action generates after installing; the api deploy generates before its tsc/vitest and redeploys on help/capability changes', () => {
    expect(read('.github/actions/npm-ci/action.yml')).toMatch(
      /run: node apps\/api\/scripts\/build-help-corpus\.mjs/
    );
    const deploy = read('.github/workflows/cf-api-deploy.yml');
    expect(deploy.indexOf('node apps/api/scripts/build-help-corpus.mjs')).toBeGreaterThan(
      deploy.indexOf('- run: npm ci')
    );
    expect(deploy.indexOf('node apps/api/scripts/build-help-corpus.mjs')).toBeLessThan(
      deploy.indexOf('tsc --noEmit -p apps/api/tsconfig.json')
    );
    expect(deploy).toContain("- 'apps/help/content/**'");
    expect(deploy).toContain("- 'capabilities/**'");
  });

  it('a help-content or capability change dry-runs the api Worker (its bundle now includes the generated corpus)', () => {
    const ws = loadWorkspaces();
    for (const f of ['apps/help/content/ar/guide.mdx', 'capabilities/store.capability.json'])
      expect(classify([f], ws).workers, f).toContain('api');
  });
});
