/**
 * The name to show for a catalog entity (product, category...) in the admin's current language.
 * Arabic falls back to the English name when no Arabic one exists; English never shows the Arabic one
 * unless it is all there is. One helper so every list renders names the same way.
 */
export function localizedName(
  locale: string,
  entity: { name?: string | null; nameAr?: string | null } | null | undefined
): string {
  if (!entity) return '';
  const en = entity.name?.trim() || '';
  const ar = entity.nameAr?.trim() || '';
  return locale === 'ar' ? ar || en : en || ar;
}
