import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

it('web deploy passes SHOW_DEMO_STORE_LINK from the repo variable, default false (Ruling B1-18)', () => {
  const y = readFileSync('.github/workflows/cf-web-deploy.yml', 'utf8');
  const flag = `--var "SHOW_DEMO_STORE_LINK:\${{ vars.SHOW_DEMO_STORE_LINK || 'false' }}"`;
  expect(y.split(flag).length - 1).toBe(2); // with and without SENTRY_DSN
});
