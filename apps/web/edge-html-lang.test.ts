import { describe, it, expect } from 'vitest';
import {
  urlLocaleOf,
  langCookie,
  isStorableHtml,
  reissueLangCookie,
  acceptsHtmlDocument,
} from './edge-html-lang';

// M-168 (LOCALE-PATHS-1 / STORE-EDGE-2): /ar and /en URL paths decide the language at the edge.
describe('urlLocaleOf (M-168)', () => {
  it.each([
    ['/ar', 'ar'],
    ['/en', 'en'],
    ['/ar/', 'ar'],
    ['/en/products/x', 'en'],
    ['/ar/cart', 'ar'],
  ])('%s -> %s', (p, l) => expect(urlLocaleOf(p)).toBe(l));
  it.each(['/', '/arabic', '/english/x', '/products/ar', '/fr', '/AR', '/a', ''])(
    '%s -> null (not a locale prefix)',
    p => expect(urlLocaleOf(p)).toBeNull()
  );
});

const html = (cookies: string[], status = 200, type = 'text/html; charset=utf-8') => {
  const h = new Headers({ 'content-type': type });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response('x', { status, headers: h });
};

describe('isStorableHtml (M-168)', () => {
  it('stores a clean 200 html page', () => expect(isStorableHtml(html([]), 'ar')).toBe(true));
  it('stores a page whose only cookie is the URL-locale cookie', () =>
    expect(isStorableHtml(html([langCookie('ar')]), 'ar')).toBe(true));
  it('refuses a cookie for the OTHER locale', () =>
    expect(isStorableHtml(html([langCookie('en')]), 'ar')).toBe(false));
  it('refuses any cookie on an unprefixed URL', () =>
    expect(isStorableHtml(html([langCookie('ar')]), null)).toBe(false));
  it('refuses a session cookie next to the language cookie', () =>
    expect(isStorableHtml(html([langCookie('ar'), 'sid=1; Path=/']), 'ar')).toBe(false));
  it('refuses a non-200 or non-html response', () => {
    expect(isStorableHtml(html([], 404), 'ar')).toBe(false);
    expect(isStorableHtml(html([], 200, 'application/json'), 'ar')).toBe(false);
  });
});

describe('reissueLangCookie (M-168)', () => {
  const req = (cookie?: string) =>
    new Request('https://s.ebda.app/ar', cookie ? { headers: { cookie } } : undefined);
  it('strips the stored cookie and re-issues the URL locale to a cookie-less visitor', () => {
    const out = html([langCookie('ar')]);
    reissueLangCookie(out, req(), 'ar');
    expect(out.headers.get('set-cookie')).toBe(langCookie('ar'));
  });
  it('does not re-issue when the visitor already carries the URL locale', () => {
    const out = html([langCookie('ar')]);
    reissueLangCookie(out, req('force-language=ar'), 'ar');
    expect(out.headers.get('set-cookie')).toBeNull();
  });
  it('re-issues when the visitor cookie differs', () => {
    const out = html([]);
    reissueLangCookie(out, req('force-language=en'), 'ar');
    expect(out.headers.get('set-cookie')).toBe(langCookie('ar'));
  });
  it('sets nothing on an unprefixed URL', () => {
    const out = html([langCookie('ar')]);
    reissueLangCookie(out, req(), null);
    expect(out.headers.get('set-cookie')).toBeNull();
  });
});

describe('acceptsHtmlDocument (M-168)', () => {
  it('accepts html, wildcard, empty and absent; refuses json/rsc', () => {
    expect(acceptsHtmlDocument('text/html,application/xhtml+xml')).toBe(true);
    expect(acceptsHtmlDocument('*/*')).toBe(true);
    expect(acceptsHtmlDocument('')).toBe(true);
    expect(acceptsHtmlDocument(null)).toBe(true);
    expect(acceptsHtmlDocument('application/json')).toBe(false);
    expect(acceptsHtmlDocument('text/x-component')).toBe(false);
  });
});
