/**
 * slugify / slugifyWithFallback
 *
 * Regression tests for the 2026-09-02 production defect: five products on a
 * live store carried the slugs '', '-1', '-2', '-3', '-4'. `slugify` returned
 * '' for the name it was given, and the caller's de-duplication loop appended a
 * counter to that empty base. The '' one was unreachable entirely — its URL
 * collapses to the product listing page.
 */

import { describe, it, expect } from 'vitest';
import { slugify, slugifyWithFallback } from './index';

describe('slugify', () => {
  it('slugifies ordinary latin names', () => {
    expect(slugify('Almond Plain')).toBe('almond-plain');
    expect(slugify('  Freeze-Dried  Natural Kiwi Slices ')).toBe(
      'freeze-dried-natural-kiwi-slices'
    );
  });

  it('strips punctuation without leaving edge dashes', () => {
    expect(slugify('Nuts & Co. — Premium!')).toBe('nuts-co-premium');
    expect(slugify('---hello---')).toBe('hello');
  });

  it('KEEPS Arabic letters instead of erasing the whole name', () => {
    // `\w` is ASCII-only, so the old implementation returned '' here.
    expect(slugify('لوز مدخن')).toBe('لوز-مدخن');
    expect(slugify('مكسرات 500 جرام')).toBe('مكسرات-500-جرام');
  });

  it('does NOT admit charsets the route validators reject', () => {
    // A wider charset (\p{L}\p{N}) would mint `café-noir`, which
    // product.routes.ts's own regex then rejects with a 400 — the server
    // generating values its own API refuses.
    expect(slugify('Café Noir')).toBe('caf-noir');
    expect(slugify('Привет мир')).toBe('');
    expect(slugify('日本語')).toBe('');
  });

  it('ascii mode drops the Arabic block too — store slugs must be ASCII', () => {
    // A store slug is the path prefix on platform hosts, and the storefront
    // middleware reads it percent-encoded from nextUrl.pathname then compares
    // it verbatim to the stored value, so a non-ASCII store slug is unroutable.
    expect(slugify('لوز مدخن', { ascii: true })).toBe('');
    expect(slugify('Almond Plain', { ascii: true })).toBe('almond-plain');
  });

  it('output always satisfies the server-side slug validators', () => {
    const PRODUCT_RE = /^[a-z0-9\u0600-\u06FF-]+$/; // product.routes.ts
    const STORE_RE = /^[a-z0-9-]+$/; // store.routes.ts
    const names = ['Almond Plain', 'لوز مدخن', 'Café Noir', 'Nuts & Co. — Premium!', '500g / 1Kg'];
    for (const n of names) {
      const product = slugifyWithFallback(n, 'product');
      expect(PRODUCT_RE.test(product), `product slug ${product} from ${n}`).toBe(true);
      const store = slugifyWithFallback(n, 'store', { ascii: true });
      expect(STORE_RE.test(store), `store slug ${store} from ${n}`).toBe(true);
    }
  });

  it('still returns empty for input with no letters or digits at all', () => {
    // Documented behaviour — this is exactly why callers that PERSIST a slug
    // must use slugifyWithFallback rather than this.
    expect(slugify('!!!')).toBe('');
    expect(slugify('   ')).toBe('');
    expect(slugify('')).toBe('');
  });
});

describe('slugifyWithFallback', () => {
  it('behaves like slugify when there is real content', () => {
    expect(slugifyWithFallback('Almond Plain', 'product')).toBe('almond-plain');
    expect(slugifyWithFallback('لوز مدخن', 'product')).toBe('لوز-مدخن');
  });

  it('NEVER returns an empty slug — the defect that reached production', () => {
    for (const input of ['', '   ', '!!!', '???', '---']) {
      const out = slugifyWithFallback(input, 'product');
      expect(out).not.toBe('');
      expect(out.startsWith('product-')).toBe(true);
    }
  });

  it('never returns a slug a de-duplication counter could turn into "-1"', () => {
    // The production shape: base '' + counter => '-1'. Assert the base can
    // never be empty or separator-only, so `${base}-1` always carries content.
    for (const input of ['', '!!!', '   ', '--', '####']) {
      const base = slugifyWithFallback(input, 'product');
      expect(/^[-\d]+$/.test(base)).toBe(false);
      expect(`${base}-1`).not.toBe('-1');
    }
  });

  it('tolerates a null/undefined name without throwing', () => {
    expect(slugifyWithFallback(undefined as unknown as string, 'product')).toMatch(/^product-/);
  });

  it('uses the caller-supplied prefix so the fallback says what it is', () => {
    expect(slugifyWithFallback('', 'store')).toMatch(/^store-/);
    expect(slugifyWithFallback('', 'product')).toMatch(/^product-/);
  });
});
