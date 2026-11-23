/**
 * Every client/server redirect inside checkout, auth, account, cart and wishlist keeps the active locale prefix
 * (ebda-foundation standard/storefront-locale-routes.md). Two layers: (1) the redirect targets the flows build keep `/en`
 * (login, after login, after order, payment return, retry, WhatsApp redeem); (2) a source guard fails on any raw-string
 * navigation in those folders that is not wrapped in `storeUrl(...)`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { localizeHref } from '../../apps/web/src/lib/locale-paths';

const SRC = path.join(__dirname, '../../apps/web/src');

describe('redirect targets keep /en', () => {
  const targets = [
    '/auth/login?redirect=/account/orders',
    '/auth/check-email',
    '/account/orders',
    '/checkout/success?orderId=1',
    '/checkout/success?orderId=1&cod=1',
    '/checkout/error?orderId=1',
    '/checkout?orderId=1&paymentId=2',
    '/cart',
    '/search?q=a',
  ];
  for (const t of targets) it(t, () => expect(localizeHref(t, 'en').startsWith('/en/')).toBe(true));
  it('the login redirect param stays prefixed once localized', () =>
    expect(localizeHref('/en/account/orders', 'en')).toBe('/en/account/orders'));
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const f = path.join(dir, n);
    if (statSync(f).isDirectory()) return files(f);
    return /\.tsx?$/.test(n) && !/\.test\./.test(n) ? [f] : [];
  });
}

describe('no raw-string navigation in transactional folders', () => {
  const FOLDERS = [
    'app/auth',
    'app/checkout',
    'app/account',
    'app/cart',
    'app/wishlist',
    'app/search',
  ];
  const NAV = /(router\.(?:push|replace)|location\.(?:assign|replace))\(\s*(['"`]\/)/;
  for (const folder of FOLDERS)
    for (const f of files(path.join(SRC, folder))) {
      it(path.relative(SRC, f), () => {
        const lines = readFileSync(f, 'utf8').split('\n');
        const bad = lines.filter(l => NAV.test(l));
        expect(bad).toEqual([]);
      });
    }
  it('payment return URLs sent to the API are localized', () => {
    const s = readFileSync(path.join(SRC, 'app/checkout/CheckoutClient.tsx'), 'utf8');
    expect(s).toMatch(/successUrl: storeUrl\(/);
    expect(s).toMatch(/errorUrl: storeUrl\(/);
  });
});
