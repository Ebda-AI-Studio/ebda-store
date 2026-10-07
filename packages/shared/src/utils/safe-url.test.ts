// packages/shared/src/utils/safe-url.test.ts
import { describe, it, expect } from 'vitest';
import { isSafeUrl, sanitizeUrl, safeInternalPath } from './safe-url';

describe('isSafeUrl', () => {
  it('accepts site-relative paths', () => {
    expect(isSafeUrl('/products')).toBe(true);
    expect(isSafeUrl('/products?sort=newest')).toBe(true);
    expect(isSafeUrl('#section')).toBe(true);
    expect(isSafeUrl('?q=shoes')).toBe(true);
    expect(isSafeUrl('./local')).toBe(true);
    expect(isSafeUrl('../up')).toBe(true);
  });

  it('accepts allowlisted absolute schemes', () => {
    expect(isSafeUrl('https://demo-shop.example')).toBe(true);
    expect(isSafeUrl('http://example.com/x')).toBe(true);
    expect(isSafeUrl('mailto:hello@store.com')).toBe(true);
    expect(isSafeUrl('tel:+201001234567')).toBe(true);
    expect(isSafeUrl('HTTPS://EXAMPLE.COM')).toBe(true); // case-insensitive
  });

  it('rejects javascript: and other dangerous schemes (XSS guard)', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('JavaScript:alert(1)')).toBe(false);
    expect(isSafeUrl('  javascript:alert(1)')).toBe(false); // leading space
    expect(isSafeUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeUrl('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeUrl('file:///etc/passwd')).toBe(false);
  });

  it('rejects control-character smuggling', () => {
    // `java\tscript:` / `java\nscript:` — browsers strip the control char.
    expect(isSafeUrl('java\tscript:alert(1)')).toBe(false);
    expect(isSafeUrl('java\nscript:alert(1)')).toBe(false);
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects empty / non-string / schemeless-bare values', () => {
    expect(isSafeUrl('')).toBe(false);
    expect(isSafeUrl('   ')).toBe(false);
    expect(isSafeUrl(null)).toBe(false);
    expect(isSafeUrl(undefined)).toBe(false);
    expect(isSafeUrl(42)).toBe(false);
    // No scheme, not relative — caller should store an absolute/relative URL.
    expect(isSafeUrl('example.com/x')).toBe(false);
  });
});

describe('sanitizeUrl', () => {
  it('returns the trimmed value for safe URLs', () => {
    expect(sanitizeUrl('/products')).toBe('/products');
    expect(sanitizeUrl('  https://example.com  ')).toBe('https://example.com');
  });

  it('returns the fallback for unsafe URLs', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBe('#');
    expect(sanitizeUrl('data:text/html,x')).toBe('#');
    expect(sanitizeUrl('javascript:alert(1)', '/products')).toBe('/products');
    expect(sanitizeUrl('', '/home')).toBe('/home');
  });
});

describe('safeInternalPath', () => {
  it('allows genuine internal paths (with query + hash)', () => {
    expect(safeInternalPath('/orders')).toBe('/orders');
    expect(safeInternalPath('/stores/abc/orders?tab=open#top')).toBe(
      '/stores/abc/orders?tab=open#top'
    );
  });

  it('rejects protocol-relative and absolute URLs', () => {
    expect(safeInternalPath('//evil.com')).toBe('/');
    expect(safeInternalPath('https://evil.com')).toBe('/');
    expect(safeInternalPath('http://evil.com/x', '/home')).toBe('/home');
  });

  it('rejects the backslash open-redirect bypass (the regression this fixes)', () => {
    // Browsers resolve `\` as `/`, so these otherwise resolve off-site.
    expect(safeInternalPath('/\\evil.com')).toBe('/');
    expect(safeInternalPath('/\\\\evil.com')).toBe('/');
    expect(safeInternalPath('/path\\to\\x')).toBe('/');
  });

  it('rejects control-char and non-string / empty inputs', () => {
    expect(safeInternalPath('/a\tb')).toBe('/');
    expect(safeInternalPath(null)).toBe('/');
    expect(safeInternalPath(undefined, '/home')).toBe('/home');
    expect(safeInternalPath('')).toBe('/');
    expect(safeInternalPath('relative/no/slash')).toBe('/');
  });
});
