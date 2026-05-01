import type { AddressJson } from './types';

export function formatMoney(fils: number, currency = 'KWD'): string {
  const major = (fils / 1000).toFixed(3);
  return `${major} ${currency}`;
}

export function formatAddressLines(addr: AddressJson | null | undefined): string[] {
  if (!addr) return [];
  const lines: string[] = [];

  const country = addr.country?.trim();
  // When both English and Arabic city/area are populated and differ,
  // show both — the merchant copying the address onto a delivery slip
  // shouldn't have to switch locales to see what the customer wrote.
  const city =
    addr.city && addr.cityAr && addr.city.trim() !== addr.cityAr.trim()
      ? `${addr.city.trim()} / ${addr.cityAr.trim()}`
      : addr.city?.trim() || addr.cityAr?.trim();
  const area =
    addr.area && addr.areaAr && addr.area.trim() !== addr.areaAr.trim()
      ? `${addr.area.trim()} / ${addr.areaAr.trim()}`
      : addr.area?.trim() || addr.areaAr?.trim();
  const head = [country, city, area].filter(Boolean).join(' - ');
  if (head) lines.push(head);

  const blockBits: string[] = [];
  if (addr.block) blockBits.push(`Block ${addr.block}`);
  if (addr.street) blockBits.push(`Street ${addr.street}`);
  else if (addr.streetAr) blockBits.push(`Street ${addr.streetAr}`);
  if (addr.avenue) blockBits.push(`Avenue ${addr.avenue}`);
  if (addr.house) blockBits.push(`House ${addr.house}`);
  if (blockBits.length) lines.push(blockBits.join(', '));

  const buildingBits: string[] = [];
  if (addr.building) buildingBits.push(`Building ${addr.building}`);
  if (addr.floor) buildingBits.push(`Floor ${addr.floor}`);
  if (addr.apartment) buildingBits.push(`Apt ${addr.apartment}`);
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
    'area',
    'block',
    'street',
    'avenue',
    'house',
    'building',
    'floor',
    'apartment',
    'notes',
    'cityAr',
    'areaAr',
    'streetAr',
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
  });
}
