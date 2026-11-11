/**
 * Guard (ebda-foundation standard/storefront-locale-routes.md): every storefront route keeps the locale prefix.
 * Walks the storefront route list (apps/web/src/app page folders) and fails if a locale-prefixed URL of any page
 * redirects to an unprefixed one. QA 2026-11-11: `/en/cart`, `/en/checkout`, `/en/account`, `/en/search` 301'd to the
 * unprefixed path (Arabic for a shopper with no cookie).
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideLocalePath, isLocaleServedRoute } from '../../apps/web/src/lib/locale-paths';

const APP = path.join(__dirname, '../../apps/web/src/app');
/** Folders under app/ that are not storefront pages: file routes, APIs, internals. */
const NOT_PAGES = new Set([
  'api',
  'og',
  'feeds',
  'landing-preview',
  'tenant-store',
  'sms-unsubscribe',
  'unsubscribe',
  'llms.txt',
  'manifest.webmanifest',
]);

function pageRoots(): string[] {
  return readdirSync(APP)
    .filter(n => !n.startsWith('_') && !n.startsWith('(') && !n.includes('.') && !NOT_PAGES.has(n))
    .filter(n => statSync(path.join(APP, n)).isDirectory())
    .filter(n => {
      const walk = (d: string): boolean =>
        readdirSync(d).some(
          f =>
            /^page\.tsx?$/.test(f) ||
            (statSync(path.join(d, f)).isDirectory() && walk(path.join(d, f)))
        );
      return walk(path.join(APP, n));
    });
}

describe('a locale-prefixed storefront route is never redirected to an unprefixed one', () => {
  const roots = pageRoots();
  it('finds the storefront routes', () => {
    expect(roots).toEqual(
      expect.arrayContaining(['cart', 'checkout', 'account', 'search', 'products'])
    );
  });
  for (const root of roots) {
    for (const locale of ['ar', 'en']) {
      it(`/${locale}/${root}`, () => {
        for (const rest of [`/${root}`, `/${root}/x`]) {
          const d = decideLocalePath({
            pathname: `/${locale}${rest}`,
            search: '?q=1',
            method: 'GET',
          });
          expect(d.kind, `${locale}${rest}`).not.toBe('redirect');
          expect(isLocaleServedRoute(rest), rest).toBe(true);
        }
      });
    }
  }
});
