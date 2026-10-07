/**
 * The eight orderable homepage sections of the legacy layout, in their
 * default render order. Single owner of this list (visual builder Phase 1):
 * `StoreLayoutSettings.sectionOrder`, the section registry and the storefront
 * renderer all read it from here instead of keeping their own copies.
 *
 * Dependency-free on purpose: `types/store-layout.ts` imports it, and the
 * registry imports `types/store-layout.ts`.
 */
export const LEGACY_HOME_SECTION_KEYS = [
  'hero',
  'categories',
  'newArrivals',
  'bestSellers',
  'brandStory',
  'blogCarousel',
  'trustStrip',
  'testimonials',
] as const;

export type LegacyHomeSectionKey = (typeof LEGACY_HOME_SECTION_KEYS)[number];

/**
 * The order the storefront renders the eight sections in for a saved
 * `sectionOrder`: known keys in saved order (unknown keys dropped, duplicates
 * collapsed), then every key the saved list omits, in default order. Moved
 * verbatim from `HomePageContent.tsx` so the adapter and the renderer agree.
 */
export function resolveLegacySectionOrder(
  saved: ReadonlyArray<string> | undefined | null
): LegacyHomeSectionKey[] {
  const all = LEGACY_HOME_SECTION_KEYS as ReadonlyArray<string>;
  if (!saved || saved.length === 0) return [...LEGACY_HOME_SECTION_KEYS];
  const seen = new Set(saved.filter((k): k is LegacyHomeSectionKey => all.includes(k)));
  const tail = LEGACY_HOME_SECTION_KEYS.filter(k => !seen.has(k));
  return [...Array.from(seen), ...tail];
}
