/**
 * Shared grid helpers used across template ProductGrid and CategoryGrid components.
 *
 * These avoid repeating the same responsive column mapping and RTL-aware
 * display-title logic in every template.
 */

/**
 * Map a column count to responsive Tailwind grid classes.
 * Falls back to a 4-column layout when the requested count is not recognised.
 */
export function getGridColsClass(columns: 2 | 3 | 4): string {
  const gridCols: Record<number, string> = {
    2: 'grid-cols-1 sm:grid-cols-2',
    3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
    4: 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4',
  };
  return gridCols[columns] ?? gridCols[4];
}

/**
 * Return the appropriate display title based on RTL mode.
 * If RTL is active and an Arabic title exists, use it; otherwise fall back to
 * the default title.
 */
export function getDisplayTitle(
  isRtl: boolean,
  title?: string,
  titleAr?: string
): string | undefined {
  return isRtl && titleAr ? titleAr : title;
}
