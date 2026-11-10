import { cookies, headers } from 'next/headers';
import { LOCALE_PATH_HEADER } from '../locale-paths';

import { resolveDefaultLanguage } from '@ebda/shared';
/**
 * The storefront's only two render locales. Kept as its own type (rather
 * than importing `Language` from LanguageContext) so this module has zero
 * client-component dependencies and can be called from server-only code
 * (`generateMetadata`, the web app manifest, JSON-LD builders).
 */
export type StorefrontLocale = 'en' | 'ar';

/**
 * Resolve the storefront locale for a server-rendered request the SAME way
 * `app/layout.tsx`'s `RootLayout` resolves `<html lang>` (see its
 * `resolvedLanguage` computation): the `force-language` cookie wins when
 * set to a known value, otherwise the store's own default language, else
 * `'en'`.
 *
 * This is the ONE place that decision should be made outside `layout.tsx` —
 * every meta-description / JSON-LD builder that needs a locale calls this,
 * so a page's `<meta name="description">` (or its Organization JSON-LD)
 * can never disagree with its own `<html lang>` again. Root cause + fix:
 * A1 in the 2026-09-22 AEO audit — every call site previously defaulted to
 * `'en'` because none of them passed a locale to `pickMetaDescription` at
 * all.
 *
 * Calls `next/headers` `cookies()`, which opts the calling route out of the
 * Full Route Cache. The dark-launched `tenant-store/[tenant]/[locale]` tree
 * is nested inside the root layout, which already calls it, so while the root
 * layout owns the store chrome that tree's metadata and body locale MUST come
 * from here too: its `[locale]` route segment is baked by middleware from the
 * cookie alone (`en` when absent), so it disagrees with the root for a
 * cookie-less visitor on an Arabic-default store (issue 2407). Use
 * `localeFromRouteParam` there only once the root stops resolving locale.
 */
export async function resolveStorefrontLocale(
  storeDefaultLanguage: string | null | undefined
): Promise<StorefrontLocale> {
  // A `/ar|/en` URL (LOCALE-PATHS-1) decides the language before any cookie does.
  const urlLang = (await headers()).get(LOCALE_PATH_HEADER);
  if (urlLang === 'ar' || urlLang === 'en') return urlLang;
  const cookieStore = await cookies();
  const cookieLang = cookieStore.get('force-language')?.value;
  if (cookieLang === 'ar' || cookieLang === 'en') return cookieLang;
  return resolveDefaultLanguage(storeDefaultLanguage);
}

/**
 * The locale a `tenant-store/[tenant]/[locale]` route segment carries, WITHOUT
 * calling `cookies()`. Cookie-only: it does not know the store's default
 * language, so it is NOT equivalent to `resolveStorefrontLocale` for a
 * cookie-less request. Safe only where the root layout no longer resolves
 * locale for this tree.
 */
export function localeFromRouteParam(param: string | undefined): StorefrontLocale {
  return param === 'ar' ? 'ar' : 'en';
}
