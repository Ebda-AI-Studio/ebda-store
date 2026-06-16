import type { AddressJson } from './orders';

/**
 * Order money is stored in fils (1 KWD = 1000 fils) — same convention as the
 * admin's order formatMoney. Non-KWD currencies use 2 decimals / 100 minor units.
 */
export function formatMoney(minor: number, currency = 'KWD'): string {
  const decimals = currency === 'KWD' ? 3 : 2;
  const divisor = currency === 'KWD' ? 1000 : 100;
  const major = (minor / divisor).toFixed(decimals);
  return `${major} ${currency}`;
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

/** Build human-readable delivery address lines (mirrors the admin helper). */
export function formatAddressLines(addr: AddressJson | null | undefined): string[] {
  if (!addr) return [];
  const lines: string[] = [];

  const head = [addr.country?.trim(), addr.city?.trim(), addr.area?.trim()]
    .filter(Boolean)
    .join(' - ');
  if (head) lines.push(head);

  const blockBits: string[] = [];
  if (addr.block) blockBits.push(`Block ${addr.block}`);
  if (addr.street) blockBits.push(`Street ${addr.street}`);
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

export function customerName(
  customer: { firstName?: string; lastName?: string } | null | undefined,
  fallback = '—'
): string {
  if (!customer) return fallback;
  const name = `${customer.firstName ?? ''} ${customer.lastName ?? ''}`.trim();
  return name || fallback;
}
