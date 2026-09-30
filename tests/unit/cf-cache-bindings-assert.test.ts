/**
 * scripts/cf-setup-local.sh (the generator) + scripts/assert-cf-cache-bindings.sh
 * (the assertion), EXECUTED together in a scratch copy of the repo layout.
 *
 * Issues 2089/2152/2154: ci.yml's cf-build-check built the COMMITTED worker
 * config, which the generator overwrites on every deploy, and never ran the
 * binding assertion — so it proved nothing about the config that ships. Both
 * cf-deploy.yml and cf-build-check now run generator → assertion.
 *
 * Issue 2240: an unset or mistyped OPENNEXT_CACHE fell into the empty-cache
 * branch and deployed a no-op revalidateTag with a green tick. The assertion
 * now demands the mode be exactly 'true' or 'false' for the storefront.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const scratch = mkdtempSync(path.join(tmpdir(), 'cf-cache-assert-'));
mkdirSync(path.join(scratch, 'scripts'));
for (const f of ['cf-setup-local.sh', 'assert-cf-cache-bindings.sh']) {
  cpSync(path.join(ROOT, 'scripts', f), path.join(scratch, 'scripts', f));
}
for (const app of ['web', 'admin', 'orders'])
  mkdirSync(path.join(scratch, 'apps', app), { recursive: true });

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(script: string, args: string[], env: Record<string, string | undefined>) {
  const e: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) e[k] = v;
  return spawnSync('bash', [path.join(scratch, 'scripts', script), ...args], {
    cwd: scratch,
    encoding: 'utf8',
    env: e,
  });
}

/** Generate the config for `app` in `mode`, then assert it in `assertMode`. */
function generateThenAssert(
  app: string,
  genMode: string | undefined,
  assertMode: string | undefined
) {
  const gen = run('cf-setup-local.sh', [app], { OPENNEXT_CACHE: genMode, CF_SETUP_SKIP_DEPS: '1' });
  expect(gen.status, gen.stdout + gen.stderr).toBe(0);
  return run('assert-cf-cache-bindings.sh', [app], { OPENNEXT_CACHE: assertMode });
}

describe('cf-setup-local.sh → assert-cf-cache-bindings.sh', () => {
  it('web, OPENNEXT_CACHE=true: the generated config carries all three cache tokens', () => {
    const r = generateThenAssert('web', 'true', 'true');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/cache bindings present/);
    // And the generator really wrote them (not a vacuous pass).
    expect(readFileSync(path.join(scratch, 'apps/web/wrangler.jsonc'), 'utf8')).toMatch(
      /NEXT_TAG_CACHE_DO_SHARDED/
    );
  });

  it('web, OPENNEXT_CACHE=false: the documented escape hatch passes', () => {
    const r = generateThenAssert('web', 'false', 'false');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/empty-cache config present/);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['mistyped True', 'True'],
    ['mistyped ture', 'ture'],
  ])(
    'web, OPENNEXT_CACHE %s: FAILS instead of deploying the silent no-op (issue 2240)',
    (_l, v) => {
      const r = generateThenAssert('web', v, v);
      expect(r.status).toBe(1);
      expect(r.stdout + r.stderr).toMatch(/must be exactly 'true'.*or 'false'/);
    }
  );

  it('web: a generator that dropped a cache binding in cache mode is caught', () => {
    generateThenAssert('web', 'true', 'true');
    const f = path.join(scratch, 'apps/web/wrangler.jsonc');
    writeFileSync(
      f,
      readFileSync(f, 'utf8').replace(/NEXT_INC_CACHE_R2_BUCKET/g, 'SOMETHING_ELSE')
    );
    const r = run('assert-cf-cache-bindings.sh', ['web'], { OPENNEXT_CACHE: 'true' });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/NO incremental-cache binding/);
  });

  it.each(['admin', 'orders'])(
    '%s never carries cache bindings, whatever the variable says',
    app => {
      const r = generateThenAssert(app, 'true', undefined);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toMatch(/empty-cache config present/);
    }
  );
});

describe('cf-deploy.yml and ci.yml cf-build-check run the SAME generator → assertion', () => {
  const cfDeploy = readFileSync(path.join(ROOT, '.github/workflows/cf-deploy.yml'), 'utf8');
  const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const cfBuildCheck = ci.slice(
    ci.indexOf('\n  cf-build-check:\n'),
    ci.indexOf('\n  test-unit:\n')
  );

  it('cf-deploy asserts the storefront config with the shared script', () => {
    expect(cfDeploy).toMatch(/run: bash scripts\/assert-cf-cache-bindings\.sh web/);
  });

  it('cf-build-check generates the config before building, then asserts it (issues 2089/2152/2154)', () => {
    const setupAt = cfBuildCheck.indexOf('bash scripts/cf-setup-local.sh ${{ matrix.app }}');
    const assertAt = cfBuildCheck.indexOf(
      'bash scripts/assert-cf-cache-bindings.sh ${{ matrix.app }}'
    );
    const buildAt = cfBuildCheck.indexOf('bash scripts/cf-build.sh ${{ matrix.app }}');
    expect(setupAt, 'cf-build-check never runs the generator').toBeGreaterThan(0);
    expect(assertAt, 'cf-build-check never asserts the generated config').toBeGreaterThan(setupAt);
    expect(buildAt, 'cf-build-check builds before generating').toBeGreaterThan(assertAt);
    expect(cfBuildCheck).toMatch(/OPENNEXT_CACHE: \$\{\{ vars\.OPENNEXT_CACHE \}\}/);
  });

  it('cf-build-check is sized for contention: serialized legs and a 3x budget (issue 2155)', () => {
    expect(cfBuildCheck).toMatch(/max-parallel: 1/);
    const t = Number(/timeout-minutes: (\d+)/.exec(cfBuildCheck)?.[1]);
    // cf-deploy budgets 25 min for ONE app's install+build+deploy.
    expect(t).toBeGreaterThanOrEqual(45);
  });
});
