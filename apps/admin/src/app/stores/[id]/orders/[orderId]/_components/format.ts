import type { AddressJson } from './types';

import { minorToDecimalString, REGION } from '@ebda/shared';
export function formatMoney(piastres: number, currency = REGION.currency): string {
  const major = minorToDecimalString(piastres);
  return `${major} ${currency}`;
}

/** Labels used when rendering individual address field names. */
export interface AddressLabels {
  block: string;
  street: string;
  avenue: string;
  house: string;
  building: string;
  floor: string;
  apt: string;
}

const DEFAULT_LABELS: AddressLabels = {
  block: 'Block',
  street: 'Street',
  avenue: 'Avenue',
  house: 'House',
  building: 'Building',
  floor: 'Floor',
  apt: 'Apt',
};

/** Extended address shape that also covers the legacy `state`/`address1`
 *  fields sent by the storefront checkout (pre-2026-06-15 orders) and
 *  admin-created orders that use the old schema keys. */
interface ExtendedAddressJson extends AddressJson {
  state?: string;
  address1?: string;
  address2?: string;
  postalCode?: string;
}

/**
 * Format an address into displayable lines.
 *
 * @param locale  The admin UI locale ('ar' | 'en' | other). When 'ar',
 *   Arabic field values (areaAr, cityAr, streetAr) are preferred over
 *   their English counterparts so the address renders in Arabic with RTL.
 */
export function formatAddressLines(
  addr: AddressJson | null | undefined,
  labels: AddressLabels = DEFAULT_LABELS,
  locale?: string
): string[] {
  if (!addr) return [];
  const isAr = locale === 'ar';
  const a = addr as ExtendedAddressJson;
  const lines: string[] = [];

  const rawCountry = a.country?.trim();
  // QA-D2: Arabic UI never prints «Egypt».
  const country = isAr && rawCountry && /^(egypt|eg)$/i.test(rawCountry) ? 'مصر' : rawCountry;

  // Resolve city: prefer Arabic on AR locale, fall back to English.
  // When both exist and differ, show the preferred one only (not both)
  // so the line is clean and readable in the current UI locale.
  const cityEn = a.city?.trim() || '';
  const cityAr = a.cityAr?.trim() || '';
  const city = isAr ? cityAr || cityEn : cityEn || cityAr;

  // Resolve area/governorate:
  //  1. Prefer structured `area`/`areaAr` fields (admin-created orders + new
  //     storefront orders that populate both).
  //  2. Fall back to legacy `state` field (storefront orders before 2026-06-15
  //     which sent `state: area_en_name` with no Arabic counterpart).
  const areaEn = a.area?.trim() || a.state?.trim() || '';
  const areaAr = a.areaAr?.trim() || '';
  const area = isAr ? areaAr || areaEn : areaEn || areaAr;

  // Egyptian checkout writes `governorate`/`governorateAr` (city stays empty).
  const govEn = a.governorate?.trim() || '';
  const govAr = a.governorateAr?.trim() || '';
  const governorate = isAr ? govAr || govEn : govEn || govAr;

  // De-duplicate so "Cairo - Cairo" (city == governorate) prints once.
  const headParts: string[] = [];
  for (const p of [country, city, area, governorate]) {
    if (p && !headParts.includes(p)) headParts.push(p);
  }
  const head = headParts.join(' - ');
  if (head) lines.push(head);

  // Resolve street: prefer AR on AR locale.
  const streetEn = a.street?.trim() || '';
  const streetAr = a.streetAr?.trim() || '';
  const street = isAr ? streetAr || streetEn : streetEn || streetAr;

  const blockBits: string[] = [];
  if (a.block) blockBits.push(`${labels.block} ${a.block}`);
  // QA-D2: shoppers type «شارع التحرير»: do not print the label twice («شارع شارع التحرير»).
  if (street) {
    blockBits.push(
      street.toLowerCase().startsWith(labels.street.toLowerCase())
        ? street
        : `${labels.street} ${street}`
    );
  }
  if (a.avenue) blockBits.push(`${labels.avenue} ${a.avenue}`);
  if (a.house) blockBits.push(`${labels.house} ${a.house}`);
  // Fallback: when no structured Egypt fields (block/street) are present,
  // use `address1` (the free-text "Block & Street" field from the storefront
  // checkout form) verbatim so the admin sees the full delivery address.
  if (blockBits.length === 0 && a.address1) {
    blockBits.push(a.address1.trim());
  }
  if (blockBits.length) lines.push(blockBits.join(', '));

  // Landmark («علامة مميزة») is stored in `address2` by the storefront checkout.
  // It is always shown on its own labelled line — never only as a fallback.
  const landmark = a.address2?.trim();
  if (landmark) lines.push(`${isAr ? 'علامة مميزة' : 'Landmark'}: ${landmark}`);

  const buildingBits: string[] = [];
  if (a.building) buildingBits.push(`${labels.building} ${a.building}`);
  if (a.floor) buildingBits.push(`${labels.floor} ${a.floor}`);
  if (a.apartment) buildingBits.push(`${labels.apt} ${a.apartment}`);
  if (buildingBits.length) lines.push(buildingBits.join(', '));

  // Safety net: surface any non-empty string fields the schema didn't
  // anticipate (e.g. coordinates, googleMapsUrl, paciNumber). The
  // delivery card never silently drops shipping info just because the
  // merchant entered it under a non-canonical key.
  const handled = new Set([
    'firstName',
    'lastName',
    'phone',
    'email',
    'country',
    'city',
    'cityAr',
    'area',
    'areaAr',
    'governorate',
    'governorateAr',
    'state',
    'block',
    'street',
    'streetAr',
    'avenue',
    'house',
    'building',
    'floor',
    'apartment',
    'notes',
    // Storefront checkout legacy fields — already consumed above
    'address1',
    'address2',
    'postalCode',
  ]);
  for (const [key, raw] of Object.entries(addr as Record<string, unknown>)) {
    if (handled.has(key)) continue;
    const value = typeof raw === 'string' ? raw.trim() : raw;
    if (value === '' || value == null || value === false) continue;
    lines.push(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
  }

  return lines;
}

export function formatDateTime(iso: string | null | undefined, locale: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    numberingSystem: 'latn', // Latin digits in both locales (issue 1971)
  });
}
