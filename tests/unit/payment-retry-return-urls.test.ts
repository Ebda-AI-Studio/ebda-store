/**
 * A retried payment returns the shopper to the STORE's own origin in their language, never the platform WEB_URL (which serves
 * no store: store.ebda.app/checkout/success is a 404, measured 2026-11-11).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { storefrontReturnUrls } from '../../apps/api/src/lib/storefront-auth-link';

describe('storefrontReturnUrls', () => {
  it('custom domain, English', () =>
    expect(storefrontReturnUrls({ slug: 'a', domain: 'ameliaaurum.com' }, 'en')).toEqual({
      callbackUrl: 'https://ameliaaurum.com/en/checkout/success',
      errorUrl: 'https://ameliaaurum.com/en/checkout/error',
    }));
  it('slug host, Arabic', () => {
    const r = storefrontReturnUrls({ slug: 'amelia' }, 'ar');
    expect(r.callbackUrl).toMatch(/^https:\/\/amelia\.[^/]+\/ar\/checkout\/success$/);
    expect(r.errorUrl).not.toContain('store.ebda.app');
  });
  it('rollback var drops the prefix', () =>
    expect(
      storefrontReturnUrls({ slug: 'a', domain: 'x.example' }, 'en', {
        STOREFRONT_LOCALE_PATHS: 'false',
      }).callbackUrl
    ).toBe('https://x.example/checkout/success'));
});

describe('payment.factory retryPayment', () => {
  const src = readFileSync(
    path.join(__dirname, '../../apps/api/src/services/payment-providers/payment.factory.ts'),
    'utf8'
  );
  it('no longer builds a return URL from config.webUrl', () => {
    expect(src).not.toMatch(/webUrl\}?\/checkout/);
    expect(src).toMatch(/callbackUrl: retryReturn\.callbackUrl/);
    expect(src).toMatch(/errorUrl: retryReturn\.errorUrl/);
  });
});
