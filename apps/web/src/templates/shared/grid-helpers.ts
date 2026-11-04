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
export function getGridColsClass(columns: 2 | 3 | 4 | 5): string {
  const gridCols: Record<number, string> = {
    2: 'grid-cols-1 sm:grid-cols-2',
    3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
    4: 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4',
    5: 'grid-cols-2 md:grid-cols-3 lg:grid-cols-5',
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

/**
 * PREMIUM-4 (audit 2026-11-03 #4): pick the desktop column count the product COUNT fills. 6 products
 * in a 4-column grid leave two on a second row; in 3 columns they are two full rows. The merchant's
 * pick wins whenever it already fills (or the count is smaller than a row); otherwise the nearest
 * count in 2..5 that divides evenly; otherwise the pick stays (the centred last row still applies).
 */
export function fitDesktopColumns(count: number, requested: number): number {
  if (count <= requested || count % requested === 0) return requested;
  const fits = [2, 3, 4, 5].filter(c => c !== requested && c <= count && count % c === 0);
  if (fits.length === 0) return requested;
  return fits.reduce((a, c) => (Math.abs(c - requested) < Math.abs(a - requested) ? c : a));
}
