import { formatPrice, minorToDecimalString, REGION } from '@force/shared';

/**
 * HTML escape for safe interpolation of user-controlled strings in email templates.
 * Mirrors the escapeHtml function in email.service.ts — kept here to avoid a
 * circular dependency when template files import from this util.
 *
 * `&` must come first so the subsequent replacements don't double-encode it.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Money in an email, in the ORDER's currency (issue 1705). The templates used
 * `minorToDecimalString(x)` with a hardcoded "EGP" / "ج.م" suffix, which prints
 * a non-EGP order (e.g. USD stored in cents) with the wrong suffix. EGP keeps its exact existing
 * rendering, so every EGP email is unchanged; any other currency goes through
 * the shared `formatPrice` the storefront and admin use.
 */
export function emailMoney(
  minor: number,
  currency: string | null | undefined,
  locale: 'en' | 'ar'
): string {
  const code = currency || REGION.currency;
  if (code === REGION.currency) {
    return `${minorToDecimalString(minor)} ${REGION.currencySymbol[locale]}`;
  }
  return formatPrice(minor, { currency: code });
}
