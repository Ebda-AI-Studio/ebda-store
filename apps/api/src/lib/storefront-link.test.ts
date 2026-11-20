import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { storefrontBase, storefrontTokenLink } from './storefront-link';

describe('storefront shopper links', () => {
  it('uses the verified custom domain, in the shopper locale', () => {
    expect(
      storefrontTokenLink({ slug: 'amelia', domain: 'Ameliaaurum.com' }, 'ar', 'verify-email', 'T')
    ).toBe('https://ameliaaurum.com/ar/auth/verify-email?token=T');
  });
  it('falls back to the platform host and honours en', () => {
    const u = new URL(storefrontTokenLink({ slug: 'amelia' }, 'en', 'reset-password', 'a~b'));
    expect(u.hostname).toBe('amelia.ebda.app');
    expect(u.pathname).toBe('/en/auth/reset-password');
    expect(u.searchParams.get('token')).toBe('a~b');
  });
  it('never points at the merchant admin host', () => {
    expect(storefrontBase({ slug: 'amelia' }, 'ar')).not.toContain('store.ebda.app');
  });
  it('no shopper mail builder reads WEB_URL / ADMIN_URL for a token link', () => {
    for (const f of ['../services/customer-auth-flows.ts', '../services/email.service.ts']) {
      const src = readFileSync(join(__dirname, f), 'utf8');
      expect(src).not.toMatch(/config\.webUrl/);
    }
    const auth = readFileSync(join(__dirname, '../services/auth.service.ts'), 'utf8');
    expect(auth).not.toMatch(/config\.webUrl\}\/auth\/(verify-email|reset-password)/);
  });
});
