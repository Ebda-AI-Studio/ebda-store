/**
 * Locale field selection for the bundle detail page — same
 * field-vs-`Ar`-twin convention product pages already use (see
 * `ProductDetailClient`'s `displayName`/`displayDescription`), pulled into
 * pure functions so the Arabic-first behavior is unit-testable without a
 * DOM-rendering harness (none is installed in this repo).
 *
 * Unlike `describeBundleContents` on the API (which requires EVERY
 * component to have an Arabic name before generating an all-Arabic
 * sentence, because a half-Arabic SENTENCE reads as a bug), component
 * names here render as a real bulleted list — a single list ITEM falling
 * back to its English name when that one component has no Arabic name is
 * normal, expected bilingual-catalog behavior, not a bug.
 */

export interface LocalizableBundle {
  name: string;
  nameAr: string | null;
  description: string | null;
  descriptionAr: string | null;
  componentNames: Array<{ name: string; nameAr: string | null }>;
}

/** `dir` for the language, matching `LanguageContext`'s `isRtl` convention. */
export function bundleDir(language: string): 'rtl' | 'ltr' {
  return language === 'ar' ? 'rtl' : 'ltr';
}

export function pickBundleName(
  bundle: Pick<LocalizableBundle, 'name' | 'nameAr'>,
  language: string
): string {
  return language === 'ar' && bundle.nameAr ? bundle.nameAr : bundle.name;
}

export function pickBundleDescription(
  bundle: Pick<LocalizableBundle, 'description' | 'descriptionAr'>,
  language: string
): string | null {
  return language === 'ar' && bundle.descriptionAr ? bundle.descriptionAr : bundle.description;
}

/** Per-item Arabic-or-English fallback — see the file header for why this differs from `describeBundleContents`'s all-or-nothing rule. */
export function pickBundleComponentNames(
  bundle: Pick<LocalizableBundle, 'componentNames'>,
  language: string
): string[] {
  return bundle.componentNames.map(c => (language === 'ar' && c.nameAr ? c.nameAr : c.name));
}
