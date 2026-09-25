export { formatPrice } from '@force/shared';

export function formatDate(date: string | null | undefined): string {
  if (!date) return '—';
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Date + time display (en-US, 12-hour clock). */
export function formatDateTime(date: string | null | undefined): string {
  if (!date) return '—';
  return new Date(date).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/** Converts a fils integer to a bare "1.500" KWD string (3 decimal places).
 *  Use for table cells where the column header already states the currency,
 *  or for <input value> fields that need a plain decimal. */
export function filsToKwd(fils: number): string {
  return (fils / 1000).toFixed(3);
}

export function formatNumber(num: number): string {
  return new Intl.NumberFormat('en-US').format(num);
}

/**
 * Parses a merchant-typed KWD amount ("12", "12.5", "0.250") into integer fils
 * WITHOUT floating-point math — `parseFloat('0.29') * 1000` is 289.99999…, and
 * a money input must never round a fil away. Accepts Arabic-Indic digits and
 * the Arabic decimal separator, since the admin is used in Arabic. Returns
 * null for anything that is not a non-negative amount with at most 3 decimals.
 */
export function kwdToFils(input: string): number | null {
  const normalized = input
    .trim()
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٫,]/g, '.');
  const match = /^(\d{1,9})(?:\.(\d{0,3}))?$/.exec(normalized);
  if (!match) return null;
  const whole = Number(match[1]);
  const frac = Number((match[2] ?? '').padEnd(3, '0'));
  return whole * 1000 + frac;
}
