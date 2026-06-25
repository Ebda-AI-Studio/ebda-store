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
