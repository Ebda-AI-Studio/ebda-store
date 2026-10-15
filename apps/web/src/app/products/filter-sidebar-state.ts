/**
 * Pure state helpers extracted from ProductsFilterSidebar.
 *
 * The component was 666 lines with depth-6 nesting and 31 branches, mixing four
 * unrelated concerns: merchant theming, debounced search, mobile-sheet lifecycle,
 * and the filter-count badge. These are the parts that carry real logic, so they
 * live here where they can be unit-tested directly — this repo has no
 * component-rendering test setup (no @testing-library/react, vitest runs in the
 * `node` environment), and adding one would be a larger change than the refactor.
 */

/**
 * Locally override --primary / --primary-foreground on the sidebar root when the
 * merchant has set custom filter colors.
 *
 * Every inner element already paints from these vars — panel background, mobile
 * sheet, category chips, price slider, sort and search — including the `/alpha`
 * shades, so one override themes the whole filter UI. CSS custom properties
 * inherit through the DOM, so the fixed-position mobile sheet (a descendant of
 * the <aside>) follows too. Unset means no override, and the store's global
 * tokens apply — which is why this returns undefined rather than an empty object.
 */
export function buildSidebarVars(
  bgTriplet?: string,
  fgTriplet?: string
): React.CSSProperties | undefined {
  if (!bgTriplet && !fgTriplet) return undefined;
  return {
    ...(bgTriplet ? { '--filter-bg': bgTriplet } : {}),
    ...(fgTriplet ? { '--filter-fg': fgTriplet } : {}),
  } as React.CSSProperties;
}

/**
 * Badge count for the "Filters" button.
 *
 * Each option NAME with at least one selected value counts once, not once per
 * value — picking three sizes is still one active filter from the shopper's
 * point of view. Search counts only when non-blank, so stray whitespace never
 * shows a phantom active filter.
 */
export function countActiveFilters(
  search: string,
  categoryFilter: string,
  optionFilters: Record<string, string[]> = {}
): number {
  const activeOptionCount = Object.values(optionFilters).filter(v => v.length > 0).length;
  return (search.trim() ? 1 : 0) + (categoryFilter ? 1 : 0) + activeOptionCount;
}
