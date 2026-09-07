import type { NavItem } from '../templates/types';

/**
 * Whether the `bundles` feature is on for this store, read off the SAME
 * `store.enabledFeatures` array `floating_widget`/`locationsEnabled` already
 * use — never a per-page-render request (P1-6, final review).
 *
 * Extracted as its own pure predicate (P2-c, scoped re-review) rather than
 * left as an inline expression in `ShopChrome.tsx`: a source-text test
 * asserting `toContain("store.enabledFeatures?.includes('bundles') ===
 * true")` reddens on a harmless rename/reformat and does not actually run
 * the predicate against real inputs (missing array, empty array, other
 * features present). This function is the one thing both `ShopChrome` and
 * its test call, so the test exercises real behaviour instead of grepping
 * a string that happens to still be there.
 */
export function bundlesNavVisible(enabledFeatures: string[] | null | undefined): boolean {
  return enabledFeatures?.includes('bundles') === true;
}

/**
 * Whether/how to auto-append a "Bundles" top-level nav entry — pure
 * decision extracted from `ShopChrome.tsx` specifically so it's unit
 * testable without a DOM-rendering harness (none is installed in this
 * repo — see `bundle-locale.ts`'s file doc comment for the same rationale).
 *
 * Mirrors the existing "Locations" auto-append shape in ShopChrome
 * (`hasExplicitLocations` / `filteredNavigation`): only appended when
 * `bundlesNavVisible` is true — read synchronously off the store-resolve
 * payload (`store.enabledFeatures` includes `bundles`), exactly as
 * `store.locationsEnabled` is, and NOT from a per-page-render request; see
 * ShopChrome's call site for why (P1-6) — AND nothing in `navigation`
 * already links to `/bundles`, so a merchant who hand-placed the link
 * themselves is respected, never duplicated.
 */
export function withBundlesNavEntry(
  navigation: NavItem[],
  bundlesNavVisible: boolean,
  bundlesHref: string
): NavItem[] {
  const isBundlesHref = (href: string) => href === bundlesHref || href.endsWith('/bundles');
  const hasExplicitBundles = navigation.some(n => isBundlesHref(n.href));
  if (!bundlesNavVisible || hasExplicitBundles) return navigation;
  return [...navigation, { label: 'Bundles', labelAr: 'الباقات', href: bundlesHref }];
}
