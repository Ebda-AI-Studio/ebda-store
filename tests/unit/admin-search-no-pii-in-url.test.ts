/**
 * Ruling SEARCH-P2-9 (extends SEARCH-T5-8): what a merchant types into an admin search box is often
 * a customer's phone or email, and URLs are retained in Cloudflare Workers Logs. No admin or
 * Orders-PWA request to the orders / customers / palette search endpoints may carry the term in the
 * URL; it goes in the `X-Search-Query` header (`searchQueryHeaders` / `moveSearchToHeader`).
 * (Product-name search, `products?search=`, is not customer data and is out of scope.)
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { moveSearchToHeader, searchQueryHeaders } from '@ebda/shared';

const ROOT = resolve(__dirname, '../..');
const walk = (d: string): string[] =>
  readdirSync(d).flatMap(n => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? (n === 'node_modules' || n === '.next' ? [] : walk(p)) : [p];
  });
const sources = ['apps/admin/src', 'apps/orders/src']
  .flatMap(d => walk(join(ROOT, d)))
  .filter(f => /\.(ts|tsx)$/.test(f) && !/\.test\.|__tests__/.test(f));

/** A request URL that puts a term in the query of an orders / customers / palette endpoint. */
const URL_WITH_TERM = [
  /\/api\/v1\/stores\/[^'"`\s]*\/search\?/, // the palette
  /\/customers\/search\?/, // New-order customer typeahead
  /\/customers(?:\/export\.xlsx)?\?[^'"`\s]*(?:search|q)=/, // customers list + export
  /\/orders(?:\/export\.xlsx)?\?[^'"`\s]*(?:search|q)=/, // orders list, export, scan lookup, PWA
];

describe('no admin search request puts the term in the URL (SEARCH-P2-9)', () => {
  it('no source builds such a URL', () => {
    const hits: string[] = [];
    for (const f of sources) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          if (URL_WITH_TERM.some(re => re.test(line)))
            hits.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it('a file that builds the orders / customers filter params moves the term to the header', () => {
    const bad = sources.filter(f => {
      const s = readFileSync(f, 'utf8');
      return /(?:order|customer)ListFilterParams\(/.test(s) && !/moveSearchToHeader\(/.test(s);
    });
    expect(bad.map(f => relative(ROOT, f))).toEqual([]);
  });

  it('the Orders PWA does not put `search` in its query params', () => {
    const pwa = readFileSync(join(ROOT, 'apps/orders/src/app/orders/page.tsx'), 'utf8');
    expect(pwa).not.toMatch(/qs\.set\('search'/);
    expect(pwa).toMatch(/searchQueryHeaders\(/);
  });
});

describe('the header helpers', () => {
  it('encode Arabic and punctuation so a header can carry them, and drop a blank term', () => {
    expect(searchQueryHeaders('  أحمد +20 101 ')).toEqual({
      'X-Search-Query': encodeURIComponent('أحمد +20 101'),
    });
    expect(decodeURIComponent(searchQueryHeaders('a@b.com')['X-Search-Query'])).toBe('a@b.com');
    expect(searchQueryHeaders('   ')).toEqual({});
    expect(searchQueryHeaders(undefined)).toEqual({});
    expect(Object.values(searchQueryHeaders('منى'))[0]).toMatch(/^[\x20-\x7e]+$/); // Latin-1 safe
  });

  it('moveSearchToHeader removes the term from the URL params and keeps the other filters', () => {
    const params = new URLSearchParams({ search: '01012345678', status: 'paid', page: '2' });
    const { params: rest, headers } = moveSearchToHeader(params);
    expect(rest.toString()).toBe('status=paid&page=2');
    expect(headers).toEqual({ 'X-Search-Query': '01012345678' });
    expect(params.get('search')).toBe('01012345678'); // input untouched
    expect(moveSearchToHeader(new URLSearchParams('status=paid')).headers).toEqual({});
  });
});
