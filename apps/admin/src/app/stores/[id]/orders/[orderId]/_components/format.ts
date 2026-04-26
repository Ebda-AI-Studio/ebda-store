import type { AddressJson } from './types';

export function formatMoney(fils: number, currency = 'KWD'): string {
  const major = (fils / 1000).toFixed(3);
  return `${major} ${currency}`;
}

export function formatAddressLines(addr: AddressJson | null | undefined): string[] {
  if (!addr) return [];
  const lines: string[] = [];

  const country = addr.country?.trim();
  const city = addr.city?.trim() || addr.cityAr?.trim();
  const area = addr.area?.trim() || addr.areaAr?.trim();
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
