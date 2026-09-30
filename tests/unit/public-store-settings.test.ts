// #782 — public.routes.ts returned `store.settings` verbatim to anonymous
// storefront visitors on GET /stores, /stores/:slugOrId and /store.
// `settings.orderInvoiceEmail` (the merchant owner's own inbox address) went
// out unredacted; `stripMarketingPixelSecrets` only ever touched the
// separate `marketingPixels` column, never `settings`.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  publicStoreSettings,
  PUBLIC_SETTINGS_KEYS,
} from '../../apps/api/src/lib/public-store-settings';

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
      acceptedPaymentMethods: ['KNET'],
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
      acceptedPaymentMethods: ['KNET'],
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

/**
 * issue 2074 — the allowlist is a contract with the storefront, so the
 * storefront source is the checklist. Every first-level `store.settings` read
 * in apps/web + apps/orders — dotted OR cast (`(store?.settings as
 * Record<string, unknown>)?.key`, possibly split across lines) — must name an
 * allowlisted key, or the value is silently dropped from the public payload.
 * Mutation-proof: removing 'acceptedPaymentMethods' from the list reddens it.
 */
describe('PUBLIC_SETTINGS_KEYS covers every storefront settings read (issue 2074)', () => {
  const READ = /[sS]tore\w*\??\.settings(?:\s+as\s+[^)]*\))?\)?\s*\??\.\s*([A-Za-z_]\w*)/g;
  /** Source with comment lines removed (a doc comment mentioning `store.settings.` is not a read). */
  function code(f: string): string {
    return readFileSync(f, 'utf8')
      .split('\n')
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
  }

  function files(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== '.next') out.push(...files(p));
      } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  }

  it('finds reads to check (guards against an empty scan)', () => {
    const root = join(__dirname, '../..');
    let n = 0;
    for (const f of [
      ...files(join(root, 'apps/web/src')),
      ...files(join(root, 'apps/orders/src')),
    ]) {
      n += [...code(f).matchAll(READ)].length;
    }
    expect(n).toBeGreaterThan(20);
  });

  it('every read key is allowlisted', () => {
    const root = join(__dirname, '../..');
    const allowed = new Set<string>(PUBLIC_SETTINGS_KEYS);
    const missing: string[] = [];
    for (const f of [
      ...files(join(root, 'apps/web/src')),
      ...files(join(root, 'apps/orders/src')),
    ]) {
      for (const m of code(f).matchAll(READ)) {
        if (!allowed.has(m[1])) missing.push(`${f.slice(root.length + 1)}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
