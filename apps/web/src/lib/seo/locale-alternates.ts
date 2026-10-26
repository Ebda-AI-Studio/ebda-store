import type { Metadata } from 'next';
import { resolveDefaultLanguage } from '@ebda/shared';
import { headers } from 'next/headers';
import {
  LOCALE_PATH_HEADER,
  LOCALE_REST_HEADER,
  localeAlternates,
  type PathLocale,
} from '../locale-paths';
import { getSiteUrl, storeAbsoluteUrl } from '../structured-data';

type StoreOrigin = { slug?: string | null; domain?: string | null; settings?: unknown };

/** The language-in-URL context the middleware asserted for this request, or null on an ordinary (unprefixed) page. */
export async function localePathContext(): Promise<{
  locale: PathLocale;
  rest: string;
} | null> {
  const h = await headers();
  const locale = h.get(LOCALE_PATH_HEADER);
  if (locale !== 'ar' && locale !== 'en') return null;
  return {
    locale,
    rest: h.get(LOCALE_REST_HEADER) || '/',
  };
}

/** The store's own default language (`settings.defaultLanguage`), the single source for x-default and the redirect. */
export function storeDefaultLocale(store: { settings?: unknown }): PathLocale {
  return resolveDefaultLanguage(
    (store.settings as Record<string, unknown> | undefined)?.defaultLanguage as string | undefined
  );
}

/**
 * `alternates` for one storefront page (audit M-168). On a `/ar|/en` page of a store that has locale paths ON:
 * the canonical in the page's own language plus reciprocal `hreflang` (ar, en, x-default = the store's default
 * language). Anywhere else: today's behaviour, unchanged, the plain canonical when `legacyCanonical` (the page
 * set one before) and nothing otherwise. `path` is the UNPREFIXED route path, with its query when it has one.
 */
export async function storefrontAlternates(
  store: StoreOrigin,
  path: string,
  legacyCanonical: boolean
): Promise<Metadata['alternates'] | undefined> {
  const ctx = await localePathContext();
  if (ctx)
    return localeAlternates({
      origin: getSiteUrl(store),
      path,
      locale: ctx.locale,
      defaultLocale: storeDefaultLocale(store),
    });
  return legacyCanonical ? { canonical: storeAbsoluteUrl(store as never, path) } : undefined;
}

/**
 * Metadata built by a synchronous builder (`buildProductMetadata`, `buildBlogPostMetadata`), with its `alternates`
 * replaced by the locale-path canonical + hreflang when the page was reached through `/ar|/en`; untouched otherwise.
 */
export async function withLocaleAlternates(
  meta: Metadata,
  store: StoreOrigin,
  path: string
): Promise<Metadata> {
  const ctx = await localePathContext();
  if (!ctx) return meta;
  return {
    ...meta,
    alternates: localeAlternates({
      origin: getSiteUrl(store),
      path,
      locale: ctx.locale,
      defaultLocale: storeDefaultLocale(store),
    }),
  };
}
