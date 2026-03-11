/**
 * Format a price value as KWD currency string.
 * Input is in fils (1 KWD = 1000 fils). Pass `{ unit: 'kwd' }` if input is already in KWD.
 */
export function formatPrice(
  amount: number,
  options?: { unit?: 'fils' | 'kwd'; locale?: string }
): string {
  const { unit = 'fils', locale = 'en-US' } = options ?? {};
  const value = unit === 'fils' ? amount / 1000 : amount;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'KWD',
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  }).format(value);
}
