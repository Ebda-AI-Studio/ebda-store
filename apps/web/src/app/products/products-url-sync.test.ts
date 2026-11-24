import { describe, expect, it } from 'vitest';
import { filterUrlSync } from './products-url-sync';

const base = 'https://shop.example/ar/products';
describe('filterUrlSync (STORE-QA-50)', () => {
  it('writes category, tag and sort into the query string', () => {
    expect(filterUrlSync(base, { category: 'rings', tag: 'new', sort: 'price-asc' })).toBe(
      '/ar/products?category=rings&tag=new&sort=price-asc'
    );
  });
  it('keeps every other param and the hash, removes cleared filters, and treats sort=default as none', () => {
    expect(
      filterUrlSync(`${base}?page=3&category=rings&utm_source=x#grid`, {
        category: '',
        tag: '',
        sort: 'default',
      })
    ).toBe('/ar/products?page=3&utm_source=x#grid');
  });
  it('returns null when the address bar already matches (no needless replaceState)', () => {
    expect(
      filterUrlSync(`${base}?category=rings`, { category: 'rings', tag: '', sort: 'default' })
    ).toBeNull();
    expect(filterUrlSync(base, { category: '', tag: '', sort: '' })).toBeNull();
  });
});
