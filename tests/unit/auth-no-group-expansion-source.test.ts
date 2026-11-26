/** QA98-ALIAS-1/2 security: a shopper's export and erasure never expand through the guest grouping (built from unverified order data). */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('account export and erasure', () => {
  it('auth.service never imports or names the guest grouping', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../apps/api/src/services/auth.service.ts'),
      'utf8'
    );
    expect(src).not.toMatch(/customer-groups/);
    expect(src).not.toMatch(/groupConsentScope|consentGroupArgs|groupScope|groupConsentKeys/);
  });

  it('the Durable Object erase op takes no group keys', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../packages/repo/src/do/erase-shopper.ts'),
      'utf8'
    );
    expect(src).not.toMatch(/groupConsentKeys|groupPhoneKeys/);
  });
});
