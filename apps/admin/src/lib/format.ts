import {
  intlLocale,
  formatPrice as sharedFormatPrice,
  minorToDecimalString,
  tryToMinor,
} from '@ebda/shared';
import { defaultLocale } from '../i18n/config';

/**
 * The admin UI language, read where the UI declares it (`<html lang>`). Money, dates and counts follow it (audit G-5:
 * an Arabic admin showed "Oct 10, 2026" and "EGP 0.00"). Server render has no document: it falls back to the default
 * locale, and every caller of these helpers renders client-fetched data after mount.
 */
function uiLocale(): 'ar' | 'en' {
  if (typeof document !== 'undefined') {
    const lang = document.documentElement.lang;
    if (lang === 'en' || lang === 'ar') return lang;
  }
  return defaultLocale;
}

/**
 * The Intl locale tag for the CURRENT UI language: use it instead of a hard-coded 'en-US' / 'en-GB' in
 * `toLocaleDateString(...)` so an Arabic admin never shows English month names (audit G-5). Arabic comes from the shared
 * `intlLocale` (Western digits pinned, Rulings NUMERALS-1 / DIGITS-1); `en` keeps its regional tag (day-first en-GB)
 * when the caller asks for it, and English always renders Western digits.
 */
export function intlLocaleForUi(english: 'en-US' | 'en-GB' = 'en-US'): string {
  return uiLocale() === 'ar' ? intlLocale('ar') : english;
}

/**
 * The admin renders Latin digits in both locales (issue 1971, Ruling
 * NUMERALS-1) — the same policy as its ICU messages (`i18n/formats.ts`). An
 * Arabic-locale price keeps its Arabic currency symbol (`1,500.00 ج.م`) but
 * not Arabic-Indic digits. House style (QA 2026-11-17 O1/N3, one formatter everywhere): thousands grouped, the currency
 * symbol in the UI language (`4,850 ج.م` / `EGP 4,850`), a whole-pound amount WITHOUT `.00` (same as the order pages and
 * the storefront) while a real fraction keeps its piastres (`450.50`). The locale defaults to the UI language; a caller
 * may still pass one. Pass `fixedDecimals: true` only for a ledger/invoice column that must align.
 */
export function formatPrice(
  amount: number,
  options?: Parameters<typeof sharedFormatPrice>[1]
): string {
  return sharedFormatPrice(amount, {
    locale: uiLocale(),
    ...options,
    numerals: 'latn',
  });
}

export function formatDate(date: string | null | undefined): string {
  if (!date) return '—';
  return new Date(date).toLocaleDateString(intlLocaleForUi(), {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Date + time display (12-hour clock), in the UI language. */
export function formatDateTime(date: string | null | undefined): string {
  if (!date) return '—';
  return new Date(date).toLocaleString(intlLocaleForUi(), {
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
  return new Intl.NumberFormat(intlLocaleForUi()).format(num);
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
