import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

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
  expect(y.indexOf('node ../../scripts/ci/populate-r2-cache.mjs')).toBeLessThan(
    y.indexOf('OPEN_NEXT_DEPLOY=true npx')
  );
});
