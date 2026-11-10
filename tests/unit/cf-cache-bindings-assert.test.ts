/**
 * scripts/cf-setup-local.sh (the generator) + scripts/assert-cf-cache-bindings.sh
 * (the assertion), EXECUTED together in a scratch copy of the repo layout.
 *
 * Issues 2089/2152/2154: ci.yml's worker-dry-run (formerly cf-build-check) built the COMMITTED worker
 * config, which the generator overwrites on every deploy, and never ran the
 * binding assertion — so it proved nothing about the config that ships. Both
 * cf-deploy.yml and cf-build-check now run generator → assertion.
 *
 * Issue 2240: an unset or mistyped OPENNEXT_CACHE fell into the empty-cache
 * branch and deployed a no-op revalidateTag with a green tick. The assertion
 * now demands the mode be exactly 'true' or 'false' for the storefront.
 */
import { BRAND } from '../../packages/shared/src/brand';
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error plain .mjs script, no types
import { CONTRACT_PATHS, contractVersion } from '../../scripts/ci/fetch-contract-version.mjs';

const ROOT = path.resolve(__dirname, '../..');
const scratch = mkdtempSync(path.join(tmpdir(), 'cf-cache-assert-'));
mkdirSync(path.join(scratch, 'scripts'));
for (const f of ['cf-setup-local.sh', 'cf-routes.cjs', 'assert-cf-cache-bindings.sh']) {
  cpSync(path.join(ROOT, 'scripts', f), path.join(scratch, 'scripts', f));
}
mkdirSync(path.join(scratch, 'packages/shared/dist/brand'), { recursive: true });
writeFileSync(
  path.join(scratch, 'packages/shared/dist/brand/index.js'),
  `exports.BRAND = ${JSON.stringify(BRAND)};`
);
for (const app of ['web', 'admin', 'orders'])
  mkdirSync(path.join(scratch, 'apps', app), { recursive: true });
// The web generator bakes the storefront's fetch-cache data-contract hash into the config (Ruling WEB-COLD-2).
mkdirSync(path.join(scratch, 'scripts/ci'), { recursive: true });
cpSync(
  path.join(ROOT, 'scripts/ci/fetch-contract-version.mjs'),
  path.join(scratch, 'scripts/ci/fetch-contract-version.mjs')
);
for (const p of CONTRACT_PATHS)
  cpSync(path.join(ROOT, p), path.join(scratch, p), { recursive: true });

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
    // WEB-COLD-2: the data-contract hash of THESE files is baked into the shared fetch cache, never the placeholder.
    const onc = readFileSync(path.join(scratch, 'apps/web/open-next.config.ts'), 'utf8');
    expect(onc).toContain(`createSharedFetchCache('${contractVersion(scratch)}')`);
    expect(onc).not.toContain('__FETCH_CONTRACT__');
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

  it.each(['true', 'false'])(
    'web, OPENNEXT_CACHE=%s: a generator that dropped the version binding is caught (Ruling EDGE-BUILD-1)',
    mode => {
      // The generated config carries it, so the assertion passes first...
      const ok = generateThenAssert('web', mode, mode);
      expect(ok.status, ok.stdout + ok.stderr).toBe(0);
      const f = path.join(scratch, 'apps/web/wrangler.jsonc');
      const generated = readFileSync(f, 'utf8');
      expect(generated).toMatch(/"version_metadata": \{ "binding": "CF_VERSION_METADATA" \}/);
      // ...and fails once the binding is gone or renamed: without it the two
      // HTML edge caches have no build id and switch themselves off.
      for (const broken of [
        generated.replace(/^.*"version_metadata".*\n/m, ''),
        generated.replace('CF_VERSION_METADATA', 'VERSION'),
      ]) {
        expect(broken).not.toBe(generated);
        writeFileSync(f, broken);
        const r = run('assert-cf-cache-bindings.sh', ['web'], { OPENNEXT_CACHE: mode });
        expect(r.status).toBe(1);
        expect(r.stdout + r.stderr).toMatch(
          /NO version_metadata binding named CF_VERSION_METADATA/
        );
      }
    }
  );

  it.each(['admin', 'orders'])(
    '%s never carries cache bindings, whatever the variable says',
    app => {
      const r = generateThenAssert(app, 'true', undefined);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toMatch(/empty-cache config present/);
    }
  );
});

describe('ci.yml worker-dry-run runs generator → assertion → build → dry-run', () => {
  const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const job = ci.slice(
    ci.indexOf('\n  worker-dry-run:\n'),
    ci.indexOf('\n  # OPS-2: the PRODUCTION build')
  );

  it('generates the config before building, then asserts it (issues 2089/2152/2154)', () => {
    const setupAt = job.indexOf('bash scripts/cf-setup-local.sh ${{ matrix.app }}');
    const assertAt = job.indexOf('bash scripts/assert-cf-cache-bindings.sh ${{ matrix.app }}');
    const buildAt = job.indexOf('bash scripts/cf-build.sh ${{ matrix.app }}');
    const dryRunAt = job.indexOf('npx wrangler deploy --dry-run');
    expect(setupAt, 'worker-dry-run never runs the generator').toBeGreaterThan(0);
    expect(assertAt, 'worker-dry-run never asserts the generated config').toBeGreaterThan(setupAt);
    expect(buildAt, 'worker-dry-run builds before generating').toBeGreaterThan(assertAt);
    expect(dryRunAt, 'worker-dry-run never starts wrangler').toBeGreaterThan(buildAt);
    expect(job.match(/OPENNEXT_CACHE: 'true'/g)).toHaveLength(2);
  });

  it('runs wrangler on Node 22 (wrangler >= 4.110 needs it) and only for apps with a config', () => {
    expect(ci).toMatch(/NODE_VERSION: '22'/);
    expect(job).toMatch(/node-version: \$\{\{ env\.NODE_VERSION \}\}/);
    // The matrix comes from scripts/ci-affected.mjs, which only lists apps that
    // have a wrangler config, so an app without one is skipped, not failed.
    expect(job).toMatch(/app: \$\{\{ fromJSON\(needs\.changes\.outputs\.workers\) \}\}/);
    expect(job).toMatch(/if: needs\.changes\.outputs\.has_workers == 'true'/);
  });

  it('each leg is its own hosted runner: no max-parallel, a roomy budget (issue 2155)', () => {
    expect(job).not.toMatch(/max-parallel/);
    const t = Number(/timeout-minutes: (\d+)/.exec(job)?.[1]);
    expect(t).toBeGreaterThanOrEqual(25);
  });
});
