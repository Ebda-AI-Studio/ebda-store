import type { AddressJson } from './orders';

import { REGION, minorToDecimalString, withNumerals } from '@force/shared';
/**
 * Order money is stored in minor units (EGP: 1 EGP = 100 piastres) — same convention as the
 * admin's order formatMoney. The decimals/scale come from `currencyExponent(currency)`.
 */
export function formatMoney(minor: number, currency = REGION.currency): string {
  return `${minorToDecimalString(minor, currency)} ${currency}`;
}

export function formatDateTime(iso: string | null | undefined, locale: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(
    locale,
    withNumerals({
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  );
}

/**
 * Tiny `{token}` interpolation for the PWA's flat dictionary (the admin uses
 * next-intl's ICU; this is the lightweight equivalent). `fmt('Remaining: {amount}',
 * { amount: '1.500 EGP' })` → `'Remaining: 1.500 EGP'`.
 */
export function fmt(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => (key in vars ? String(vars[key]) : `{${key}}`));
}

/** Labels used when rendering individual address field names (bilingual). */
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

/** Extended address shape covering legacy storefront-checkout keys. */
interface ExtendedAddressJson extends AddressJson {
  state?: string;
  address1?: string;
  address2?: string;
  postalCode?: string;
}

/**
 * Build human-readable delivery address lines — richer bilingual / Egypt-aware
 * version ported from the admin order-detail `formatAddressLines`. When `locale`
 * is `'ar'`, Arabic field values (areaAr, cityAr, streetAr) are preferred over
 * their English counterparts. Legacy `state` / `address1` keys from pre-2026-06-15
 * storefront orders are handled, and any non-canonical string field is surfaced
 * rather than silently dropped.
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

  const country = a.country?.trim();

  const cityEn = a.city?.trim() || '';
  const cityAr = a.cityAr?.trim() || '';
  const city = isAr ? cityAr || cityEn : cityEn || cityAr;

  const areaEn = a.area?.trim() || a.state?.trim() || '';
  const areaAr = a.areaAr?.trim() || '';
  const area = isAr ? areaAr || areaEn : areaEn || areaAr;

  const head = [country, city, area].filter(Boolean).join(' - ');
  if (head) lines.push(head);

  const streetEn = a.street?.trim() || '';
  const streetAr = a.streetAr?.trim() || '';
  const street = isAr ? streetAr || streetEn : streetEn || streetAr;

  const blockBits: string[] = [];
  if (a.block) blockBits.push(`${labels.block} ${a.block}`);
  if (street) blockBits.push(`${labels.street} ${street}`);
  if (a.avenue) blockBits.push(`${labels.avenue} ${a.avenue}`);
  if (a.house) blockBits.push(`${labels.house} ${a.house}`);
  if (blockBits.length === 0 && a.address1) {
    blockBits.push(a.address1.trim());
    if (a.address2?.trim()) blockBits.push(a.address2.trim());
  }
  if (blockBits.length) lines.push(blockBits.join(', '));

  const buildingBits: string[] = [];
  if (a.building) buildingBits.push(`${labels.building} ${a.building}`);
  if (a.floor) buildingBits.push(`${labels.floor} ${a.floor}`);
  if (a.apartment) buildingBits.push(`${labels.apt} ${a.apartment}`);
  if (buildingBits.length) lines.push(buildingBits.join(', '));

  // Surface any unexpected non-empty string fields rather than dropping them.
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
    'state',
    'governorate',
    'governorateAr',
    'block',
    'street',
    'streetAr',
    'avenue',
    'house',
    'building',
    'floor',
    'apartment',
    'notes',
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

export function customerName(
  customer: { firstName?: string; lastName?: string } | null | undefined,
  fallback = '—'
): string {
  if (!customer) return fallback;
  const name = `${customer.firstName ?? ''} ${customer.lastName ?? ''}`.trim();
  return name || fallback;
}
