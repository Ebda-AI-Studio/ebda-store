/**
 * Shared by the Worker's two HTML edge caches (demo-edge-cache.ts, store-edge-cache.ts): the storefront language
 * cookie on a `/ar|/en` URL (Rulings LOCALE-PATHS-1, STORE-EDGE-2).
 *
 * On a `/ar|/en` path the URL decides the language; the render ignores the `force-language` cookie, and the middleware
 * only WRITES it (to the URL's locale) when the visitor's cookie differs, so unprefixed pages (cart, checkout) match.
 * A first visitor has no cookie, so every first render carries that Set-Cookie, and a cache that refuses any Set-Cookie
 * never stores the page a viral spike is made of (measured on storedemo.ebda.app/ar, 2026-11-09: 2.95 s cookie-less, a
 * HIT only with the cookie). So: the one cookie that equals the URL's locale is allowed, stripped from the stored copy,
 * and re-issued to each visitor whose cookie differs. Any other Set-Cookie still refuses storage.
 */
const LOCALE_PREFIX = /^\/(ar|en)(?=\/|$)/;
const LANG_COOKIE_MAX_AGE = 31536000;

export type UrlLocale = 'ar' | 'en' | null;

/**
 * A document request: `Accept` names text/html, is the any-type wildcard, or is absent (link-preview and social crawlers, curl, many bots;
 * the viral first wave of a shared link). An RSC, prefetch or action request is refused by its own headers first, and
 * only a `text/html` RESPONSE is ever stored, so a non-HTML answer cannot enter the cache this way (Ruling STORE-EDGE-3).
 */
export function acceptsHtmlDocument(accept: string | null): boolean {
  if (accept === null || accept.trim() === '' || accept.trim() === '*/*') return true;
  return accept.includes('text/html');
}

/** The `ar|en` a path starts with, or null. */
export function urlLocaleOf(path: string): UrlLocale {
  const m = LOCALE_PREFIX.exec(path);
  return m ? (m[1] as 'ar' | 'en') : null;
}

/** The Set-Cookie the middleware writes on a `/ar|/en` path (middleware.ts, same attributes). */
export function langCookie(locale: 'ar' | 'en'): string {
  return `force-language=${locale}; Path=/; Max-Age=${LANG_COOKIE_MAX_AGE}; Secure; SameSite=lax`;
}

function setCookiesOf(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const one = res.headers.get('set-cookie');
  return one === null ? [] : [one];
}

/** A clean 200 HTML document, with no Set-Cookie but the URL-locale language cookie. */
export function isStorableHtml(res: Response, urlLocale: UrlLocale): boolean {
  if (res.status !== 200 || !(res.headers.get('content-type') ?? '').includes('text/html'))
    return false;
  const cookies = setCookiesOf(res);
  if (cookies.length === 0) return true;
  // A comma-joined header (`a=1; ..., b=2`) hides a second cookie; an Expires date (`Tue, 09 Nov`) does not match.
  return (
    urlLocale !== null &&
    cookies.every(c => c.startsWith(`force-language=${urlLocale};`) && !/,\s*[^;=\s]+=/.test(c))
  );
}

/** On a SHARED copy: no stored cookie ever, and the URL's language re-issued when the visitor's cookie differs. */
export function reissueLangCookie(out: Response, request: Request, urlLocale: UrlLocale): void {
  out.headers.delete('set-cookie');
  if (!urlLocale) return;
  const has = /^force-language=(ar|en)$/.exec((request.headers.get('cookie') ?? '').trim())?.[1];
  if (has !== urlLocale) out.headers.append('set-cookie', langCookie(urlLocale));
}
