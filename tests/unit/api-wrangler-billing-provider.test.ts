import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { billingProviderUnsetWarning } from '../../apps/api/src/services/billing';

// Ruling BILLING-NONE-1 (M-032): production runs InstaPay-only on purpose until Kashier is approved.
it('the API wrangler config sets BILLING_PROVIDER=none, which silences the unset-provider P1', () => {
  const src = readFileSync('apps/api/wrangler.jsonc', 'utf8');
  expect(src).toMatch(/^\s*"BILLING_PROVIDER":\s*"none",/m);
  expect(
    billingProviderUnsetWarning({ NODE_ENV: 'production', BILLING_PROVIDER: 'none' })
  ).toBeNull();
});
