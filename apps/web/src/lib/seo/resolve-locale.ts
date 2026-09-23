import { cookies } from 'next/headers';

/**
 * The storefront's only two render locales. Kept as its own type (rather
 * than importing `Language` from LanguageContext) so this module has zero
 * client-component dependencies and can be called from server-only code
 * (`generateMetadata`, `manifest.ts`, JSON-LD builders).
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
 * Full Route Cache — fine for the legacy header-based tree, which is
 * already fully dynamic. The dark-launched `tenant-store/[tenant]/[locale]`
 * tree must NOT call this (it would defeat the whole point of that tree);
 * use `localeFromRouteParam` there instead, since the middleware already
 * baked the cookie's value into the `[locale]` route segment.
 */
export async function resolveStorefrontLocale(
  storeDefaultLanguage: string | null | undefined
): Promise<StorefrontLocale> {
  const cookieStore = await cookies();
  const cookieLang = cookieStore.get('force-language')?.value;
  if (cookieLang === 'ar' || cookieLang === 'en') return cookieLang;
  return storeDefaultLanguage === 'ar' ? 'ar' : 'en';
}

/**
 * Same resolution as `resolveStorefrontLocale`, but for callers in the
 * dark-launched `tenant-store/[tenant]/[locale]` tree, which already have
 * the resolved locale as a route param (baked in by `middleware.ts` from
 * the `force-language` cookie before the rewrite — see that tree's
 * `layout.tsx` doc comment). No `cookies()` call, so it stays
 * cache-friendly.
 */
export function localeFromRouteParam(param: string | undefined): StorefrontLocale {
  return param === 'ar' ? 'ar' : 'en';
}
