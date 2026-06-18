/**
 * Pure filter helpers for GovernorateAreaSelect.
 * Kept in a separate .ts file so vitest (node environment, no JSX) can import
 * and unit-test them without requiring a DOM or JSX transformer.
 */
import { KUWAIT_GOVERNORATES, areasForGovernorate } from '@force/shared';
import type { KuwaitArea, KuwaitGovernorate } from '@force/shared';

/** Filter governorates by query (substring in en or ar) and optional rated set */
export function filterGovernorates(
  query: string,
  ratedGovernorates?: Set<string>
): KuwaitGovernorate[] {
  const q = query.trim().toLowerCase();
  return KUWAIT_GOVERNORATES.filter(gov => {
    // If a rated filter is provided, hide governorates not in the set
    if (ratedGovernorates && ratedGovernorates.size > 0 && !ratedGovernorates.has(gov.en)) {
      return false;
    }
    if (!q) return true;
    return gov.en.toLowerCase().includes(q) || gov.ar.includes(query.trim());
  });
}

/** Filter areas for a given governorate by query and optional rated set */
export function filterAreas(
  governorateEn: string,
  query: string,
  ratedAreas?: Set<string>
): KuwaitArea[] {
  const areas = areasForGovernorate(governorateEn);
  const q = query.trim().toLowerCase();
  return areas.filter(area => {
    if (ratedAreas && ratedAreas.size > 0 && !ratedAreas.has(area.en)) {
      return false;
    }
    if (!q) return true;
    return area.en.toLowerCase().includes(q) || area.ar.includes(query.trim());
  });
}
