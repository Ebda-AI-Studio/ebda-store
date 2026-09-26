// #782 — public.routes.ts returned `store.settings` verbatim to anonymous
// storefront visitors on GET /stores, /stores/:slugOrId and /store.
// `settings.orderInvoiceEmail` (the merchant owner's own inbox address) went
// out unredacted; `stripMarketingPixelSecrets` only ever touched the
// separate `marketingPixels` column, never `settings`.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { publicStoreSettings } from '../../apps/api/src/lib/public-store-settings';

describe('publicStoreSettings — allowlists storefront-consumed keys only', () => {
  it('drops orderInvoiceEmail (owner PII) and any other unlisted key', () => {
    const out = publicStoreSettings({
      orderInvoiceEmail: 'owner@example.com',
      someFutureAdminOnlyField: 'secret',
    });
    expect(out).not.toHaveProperty('orderInvoiceEmail');
    expect(out).not.toHaveProperty('someFutureAdminOnlyField');
  });

  it('keeps every key the storefront actually renders', () => {
    const input = {
      defaultLanguage: 'ar',
      navMenu: [{ label: 'Home', href: '/' }],
      footerLinks: [{ label: 'About', href: '/about' }],
      utilityBar: { text: 'Free shipping' },
      contact: { addressUrl: 'https://maps.example' },
      floatingWidget: { enabled: true },
      checkoutLabel: 'Secure Checkout',
      checkoutLabelAr: 'دفع آمن',
      checkoutDelivery: { windows: { enabled: true, items: [] } },
      minimumOrderFils: 5000,
      orderInvoiceEmail: 'owner@example.com',
    };
    const out = publicStoreSettings(input);
    expect(out).toEqual({
      defaultLanguage: 'ar',
      navMenu: input.navMenu,
      footerLinks: input.footerLinks,
      utilityBar: input.utilityBar,
      contact: input.contact,
      floatingWidget: input.floatingWidget,
      checkoutLabel: 'Secure Checkout',
      checkoutLabelAr: 'دفع آمن',
      checkoutDelivery: input.checkoutDelivery,
      minimumOrderFils: 5000,
    });
  });

  it('is safe on null/non-object input', () => {
    expect(publicStoreSettings(null)).toEqual({});
    expect(publicStoreSettings(undefined)).toEqual({});
    expect(publicStoreSettings('not an object')).toEqual({});
  });
});

describe('public.routes.ts — every `settings: true` response is redacted (#782)', () => {
  const src = readFileSync(join(__dirname, '../../apps/api/src/routes/public.routes.ts'), 'utf8');

  it('imports the redaction helper', () => {
    expect(src).toMatch(
      /import\s*\{\s*publicStoreSettings\s*\}\s*from\s*'\.\.\/lib\/public-store-settings'/
    );
  });

  it('calls publicStoreSettings() at least once per `settings: true` select', () => {
    const selectCount = (src.match(/settings:\s*true/g) ?? []).length;
    const callCount = (src.match(/publicStoreSettings\(/g) ?? []).length;
    expect(
      selectCount,
      'this test itself must find at least one `settings: true` select to be meaningful'
    ).toBeGreaterThan(0);
    expect(
      callCount,
      `public.routes.ts selects "settings: true" ${selectCount} time(s) but only calls ` +
        `publicStoreSettings() ${callCount} time(s) — a response path is serving unredacted settings`
    ).toBeGreaterThanOrEqual(selectCount);
  });
});
