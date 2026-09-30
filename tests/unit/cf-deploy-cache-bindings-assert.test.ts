/**
 * #1300: the "Assert the generated worker config" step ran unconditionally,
 * so the moment OPENNEXT_CACHE is unset, misspelled, or deliberately flipped
 * off — the DOCUMENTED, "ZERO risk" fallback scripts/cf-setup-local.sh's own
 * comment describes — the assert failed anyway and the entire web deploy job
 * exited 1. The escape hatch for a bad cache rollout became a way to lose the
 * ability to deploy the storefront at all.
 *
 * This extracts the REAL step script from the workflow and runs it against
 * fixture wrangler.jsonc / open-next.config.ts files shaped exactly like
 * cf-setup-local.sh's two branches, for both values of OPENNEXT_CACHE.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Job = { steps?: Step[] };
type Workflow = { jobs?: Record<string, Job> };

const WF_PATH = join(__dirname, '../../.github/workflows/cf-deploy.yml');
const doc = yaml.load(readFileSync(WF_PATH, 'utf8')) as Workflow;
const assertStep = doc.jobs?.['deploy-web']?.steps?.find(s =>
  (s.name ?? '').startsWith('Assert the generated worker config')
);

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const CACHED_WRANGLER = JSON.stringify({
  name: 'force-web-cf-preview',
  r2_buckets: [{ binding: 'NEXT_INC_CACHE_R2_BUCKET', bucket_name: 'force-web-opennext-cache' }],
  durable_objects: {
    bindings: [{ name: 'NEXT_TAG_CACHE_DO_SHARDED', class_name: 'DOShardedTagCache' }],
  },
});
const CACHED_CONFIG =
  "import { defineCloudflareConfig } from '@opennextjs/cloudflare';\n" +
  'export default defineCloudflareConfig({ tagCache: {} });\n';

const EMPTY_WRANGLER = JSON.stringify({ name: 'force-web-cf-preview' });
const EMPTY_CONFIG =
  "import { defineCloudflareConfig } from '@opennextjs/cloudflare';\n" +
  'export default defineCloudflareConfig({});\n';

function runAssert(opennextCache: string, wrangler: string, config: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cf-assert-'));
  dirs.push(dir);
  const appDir = join(dir, 'apps', 'web');
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, 'wrangler.jsonc'), wrangler);
  writeFileSync(join(appDir, 'open-next.config.ts'), config);

  const scriptPath = join(dir, 'assert.sh');
  writeFileSync(scriptPath, `#!/usr/bin/env bash\nset -euo pipefail\n${assertStep!.run}\n`);

  return spawnSync('bash', [scriptPath], {
    cwd: appDir,
    encoding: 'utf8',
    env: { ...process.env, OPENNEXT_CACHE: opennextCache },
  });
}

describe('cf-deploy.yml "Assert the generated worker config" step', () => {
  it('the step was found (guards against a rename silently disabling this suite)', () => {
    expect(assertStep?.run).toBeTruthy();
  });

  it('passes when OPENNEXT_CACHE=true and the cache bindings are present', () => {
    const r = runAssert('true', CACHED_WRANGLER, CACHED_CONFIG);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it('fails when OPENNEXT_CACHE=true but the generator dropped a binding', () => {
    const r = runAssert('true', EMPTY_WRANGLER, CACHED_CONFIG);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/NO tag-cache binding/);
  });

  it('#1300: passes when OPENNEXT_CACHE is UNSET and the config is the documented empty fallback', () => {
    const r = runAssert('', EMPTY_WRANGLER, EMPTY_CONFIG);
    expect(
      r.status,
      `must not fail the whole web deploy on the documented, "ZERO risk" fallback: ${r.stdout}${r.stderr}`
    ).toBe(0);
  });

  it('#1300: passes when OPENNEXT_CACHE=false explicitly and the config is the empty fallback', () => {
    const r = runAssert('false', EMPTY_WRANGLER, EMPTY_CONFIG);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it('still fails when OPENNEXT_CACHE is off but the generator wrongly emitted cache bindings anyway', () => {
    const r = runAssert('', CACHED_WRANGLER, EMPTY_CONFIG);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/did not produce the documented empty-cache fallback/);
  });
});
