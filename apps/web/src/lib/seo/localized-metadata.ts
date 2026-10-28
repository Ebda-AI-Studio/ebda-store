import type { Metadata } from 'next';
import { getStore } from '../store-resolver';
import { resolveStorefrontLocale } from './resolve-locale';
import { localePathContext, storeDefaultLocale } from './locale-alternates';
import { getSiteUrl } from '../structured-data';
import { localeAlternates } from '../locale-paths';

/**
 * Quality bar § 10 rule (f) (W4, a11y P1-3): a static route's <title> and description in the page
 * language, resolved exactly as <html lang> is (cookie, else the store's default language). Pass
 * `[english, arabic]` pairs; everything else in `rest` is copied as is.
 */
export async function localizedMetadata({
  title,
  description,
  ...rest
}: {
  title: [string, string];
  description?: [string, string];
} & Omit<Metadata, 'title' | 'description'>): Promise<Metadata> {
  const store = await getStore().catch(() => null);
  const locale = await resolveStorefrontLocale(
    (store?.settings as Record<string, unknown> | undefined)?.defaultLanguage as string | undefined
  );
  const pick = (p: [string, string]) => (locale === 'ar' ? p[1] : p[0]);
  // A page of a locale-path store (`/ar|/en`, LOCALE-PATHS-1) gets its canonical + hreflang here, so every route that
  // already goes through this helper is covered; a page that passes its own `alternates` in `rest` overrides it.
  const pathCtx = store ? await localePathContext() : null;
  const alternates =
    store && pathCtx
      ? localeAlternates({
          origin: getSiteUrl(store),
          path: pathCtx.rest,
          locale: pathCtx.locale,
          defaultLocale: storeDefaultLocale(store),
        })
      : undefined;
  return {
    ...(alternates ? { alternates } : {}),
    ...rest,
    title: pick(title),
    ...(description ? { description: pick(description) } : {}),
  };
}
