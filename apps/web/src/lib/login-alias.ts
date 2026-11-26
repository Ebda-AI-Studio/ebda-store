/**
 * Shoppers (and old links, and crawlers) guess `/login`, `/account/login`, `/ar/login`, `/ar/account/login`.
 * The one real storefront sign-in page is `/auth/login` (never language-prefixed). Those guesses are a
 * permanent redirect to it, query string intact so `?returnTo=` / `?redirect=` survives.
 */
const LOGIN_ALIAS = /^\/(?:(ar|en)\/)?(?:account\/)?login\/?$/i;

export function loginAliasRedirect(
  pathname: string,
  search: string
): { location: string; locale: 'ar' | 'en' | null } | null {
  const m = LOGIN_ALIAS.exec(pathname);
  if (!m) return null;
  const locale = m[1] ? (m[1].toLowerCase() as 'ar' | 'en') : null;
  return { location: `/auth/login${search}`, locale };
}
