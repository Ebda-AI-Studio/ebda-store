/**
 * a11y P1-3 / quality bar § 10 rule (f) (W4): Cart, Checkout, Products and Order Confirmed had
 * English <title>s on Arabic pages (2.4.2 / 3.1.1). Static route titles go through one helper that
 * reads the page locale the way <html lang> does.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

let lang: 'ar' | 'en' = 'ar';
vi.mock('./resolve-locale', () => ({ resolveStorefrontLocale: async () => lang }));
vi.mock('../store-resolver', () => ({
  getStore: async () => ({ settings: { defaultLanguage: 'ar' } }),
}));

const { localizedMetadata } = await import('./localized-metadata');

describe('localizedMetadata', () => {
  it('Arabic page: Arabic title and description', async () => {
    lang = 'ar';
    const m = await localizedMetadata({
      title: ['Cart', 'السلة'],
      description: ['Review your cart.', 'راجع سلتك.'],
    });
    expect(m.title).toBe('السلة');
    expect(m.description).toBe('راجع سلتك.');
  });
  it('English page: English', async () => {
    lang = 'en';
    const m = await localizedMetadata({ title: ['Cart', 'السلة'] });
    expect(m.title).toBe('Cart');
  });
  it.each([
    'app/cart/page.tsx',
    'app/checkout/page.tsx',
    'app/products/page.tsx',
    'app/checkout/success/page.tsx',
  ])('%s titles through the helper (no static English title)', f => {
    const s = readFileSync(path.resolve(__dirname, '../..', f), 'utf8');
    expect(s).toContain('localizedMetadata(');
    expect(s).not.toMatch(/export const metadata: Metadata = \{\s*title:/);
  });
});

// Rule (f) as a class gate: no storefront route keeps a static English <title>.
describe('no static English title on any storefront route', () => {
  it('every app/**/page.tsx titles through localizedMetadata or its own generateMetadata', async () => {
    const { readdirSync, statSync } = await import('node:fs');
    const app = path.resolve(__dirname, '../../app');
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap(n => {
        const p = path.join(d, n);
        return statSync(p).isDirectory() ? walk(p) : n === 'page.tsx' ? [p] : [];
      });
    const hits = walk(app).filter(f =>
      /export const metadata: Metadata = \{[^}]*title:\s*'/.test(readFileSync(f, 'utf8'))
    );
    expect(hits.map(f => path.relative(app, f))).toEqual([]);
  });
});
