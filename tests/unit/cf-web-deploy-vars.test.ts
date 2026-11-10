import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

it('web deploy passes SHOW_DEMO_STORE_LINK from the repo variable, default false (Ruling B1-18)', () => {
  const y = readFileSync('.github/workflows/cf-web-deploy.yml', 'utf8');
  const flag = `--var "SHOW_DEMO_STORE_LINK:\${{ vars.SHOW_DEMO_STORE_LINK || 'false' }}"`;
  expect(y.split(flag).length - 1).toBe(1); // one VARS array; SENTRY_DSN is appended when set
});

it('web deploy turns language-in-the-URL on for every store host, overridable by repo variables (Ruling LOCALE-PATHS-2)', () => {
  const y = readFileSync('.github/workflows/cf-web-deploy.yml', 'utf8');
  expect(y).toContain(
    `--var "STOREFRONT_LOCALE_PATHS:\${{ vars.STOREFRONT_LOCALE_PATHS || 'true' }}"`
  );
  expect(y).toContain(
    `--var "STOREFRONT_LOCALE_PATHS_STORES:\${{ vars.STOREFRONT_LOCALE_PATHS_STORES || 'all' }}"`
  );
  // Ruling DEPLOY-R2-POPULATE-2: REST populate, then the plain wrangler deploy with OpenNext's recursion guard.
  expect(y).toContain('node ../../scripts/ci/populate-r2-cache.mjs');
  expect(y).toContain('OPEN_NEXT_DEPLOY=true npx wrangler deploy "${VARS[@]}"');
  expect(y).not.toContain('opennextjs-cloudflare deploy');
  // Order, structurally. A workflow cannot run in a unit test (GitHub runner, Cloudflare credentials), so parse the YAML,
  // take the `deploy` job's step that holds the deploy command, and compare the EXECUTABLE lines of its `run` script:
  // comments are dropped (a comment mentioning the command is not a call) and the populate must be an unconditional,
  // top-level command, not an indented `if` branch.
  const wf = parse(y) as {
    jobs: { deploy: { steps: Array<{ name?: string; run?: string }> } };
  };
  const steps = wf.jobs.deploy.steps.filter(s => s.run?.includes('wrangler deploy "${VARS[@]}"'));
  expect(steps).toHaveLength(1);
  const lines = steps[0]
    .run!.split('\n')
    .filter(l => l.trim() !== '' && !l.trimStart().startsWith('#'));
  const populate = lines.findIndex(l =>
    l.startsWith('node ../../scripts/ci/populate-r2-cache.mjs')
  );
  const deploy = lines.findIndex(l => l.startsWith('OPEN_NEXT_DEPLOY=true npx wrangler deploy'));
  expect(populate).toBeGreaterThan(-1);
  expect(deploy).toBeGreaterThan(-1);
  expect(populate).toBeLessThan(deploy);
});
