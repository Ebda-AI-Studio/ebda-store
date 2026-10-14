import { formatPrice as sharedFormatPrice, minorToDecimalString, tryToMinor } from '@ebda/shared';

/**
 * The admin renders Latin digits in both locales (issue 1971, Ruling
 * NUMERALS-1) — the same policy as its ICU messages (`i18n/formats.ts`). An
 * Arabic-locale price keeps its Arabic currency symbol (`1,500.00 ج.م`) but
 * not Arabic-Indic digits. The admin is an accounting surface, so it keeps
 * every decimal (`EGP 450.00`); the storefront trims a zero fraction.
 */
export function formatPrice(
  amount: number,
  options?: Parameters<typeof sharedFormatPrice>[1]
): string {
  return sharedFormatPrice(amount, { ...options, numerals: 'latn', fixedDecimals: true });
}

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

/** Converts a piastres integer to a bare "15.00" EGP string (2 decimal places).
 *  Use for table cells where the column header already states the currency,
 *  or for <input value> fields that need a plain decimal. */
export function minorToMajor(piastres: number): string {
  return minorToDecimalString(piastres);
}

export function formatNumber(num: number): string {
  return new Intl.NumberFormat('en-US').format(num);
}

/**
 * Parses a merchant-typed EGP amount ("12", "12.5", "0.25") into integer piastres
 * WITHOUT floating-point math — `parseFloat('0.29') * 100` is 28.999…, and
 * a money input must never round a piastre away. Accepts Arabic-Indic digits and
 * the Arabic decimal separator, since the admin is used in Arabic. Returns
 * null for anything that is not a non-negative amount with at most
 * `REGION.currencyDecimals` (2) decimals — `'1.999'` is rejected, never rounded.
 */
export function majorToMinor(input: string): number | null {
  const normalized = input.trim().replace(/[٫,]/g, '.');
  if (!/^[\d٠-٩۰-۹]{1,9}(?:\.[\d٠-٩۰-۹]*)?$/.test(normalized)) return null;
  return tryToMinor(normalized);
}
