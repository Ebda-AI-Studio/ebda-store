import { describe, it, expect } from 'vitest';
import { parseQrPath, qrLocation } from './route';

describe('parseQrPath', () => {
  it('maps the four short links', () => {
    expect(parseQrPath(['s'])).toEqual({ kind: 'store' });
    expect(parseQrPath(['w'])).toEqual({ kind: 'whatsapp' });
    expect(parseQrPath(['p', 'ring'])).toEqual({ kind: 'product', slug: 'ring' });
    expect(parseQrPath(['c', encodeURIComponent('خواتم')])).toEqual({
      kind: 'category',
      slug: 'خواتم',
    });
  });
  it('rejects everything else', () => {
    expect(parseQrPath(undefined)).toBeNull();
    expect(parseQrPath([])).toBeNull();
    expect(parseQrPath(['x'])).toBeNull();
    expect(parseQrPath(['p'])).toBeNull(); // product needs a slug
    expect(parseQrPath(['s', 'extra'])).toBeNull();
    expect(parseQrPath(['p', 'a', 'b'])).toBeNull();
  });
});

describe('qrLocation', () => {
  const origin = 'https://shop.ebda.app';
  it('adds utm to a store page and keeps existing query', () => {
    const u = new URL(qrLocation('/products?category=rings', 'category', origin)!);
    expect(u.origin + u.pathname).toBe('https://shop.ebda.app/products');
    expect(u.searchParams.get('category')).toBe('rings');
    expect(u.searchParams.get('utm_source')).toBe('qr');
    expect(u.searchParams.get('utm_medium')).toBe('print');
    expect(u.searchParams.get('utm_campaign')).toBe('category');
  });
  it('sends WhatsApp straight to wa.me only', () => {
    expect(qrLocation('https://wa.me/201012345678?text=hi', 'whatsapp', origin)).toBe(
      'https://wa.me/201012345678?text=hi'
    );
    expect(qrLocation('https://evil.example/', 'whatsapp', origin)).toBeNull();
  });
  it('never redirects off-site for a store page (open-redirect guard)', () => {
    expect(qrLocation('//evil.example/x', 'store', origin)).toBeNull();
    expect(qrLocation('https://evil.example/x', 'product', origin)).toBeNull();
  });
});
