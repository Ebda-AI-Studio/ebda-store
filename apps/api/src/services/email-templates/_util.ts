import { formatMoney, formatPrice, REGION } from '@ebda/shared';

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
 * Money in an email, in the ORDER's currency (issue 1705). EGP keeps its
 * number-then-symbol layout (`450 ج.م` / `450 EGP`) with Western digits and no
 * zero fraction (`1,299.50` keeps its piastres) — Ruling NUMERALS-1; any other
 * currency goes through the shared `formatPrice` the storefront and admin use.
 */
export function emailMoney(
  minor: number,
  currency: string | null | undefined,
  locale: 'en' | 'ar'
): string {
  const code = currency || REGION.currency;
  if (code === REGION.currency) {
    return `${formatMoney(minor, locale, { hideSymbol: true })} ${REGION.currencySymbol[locale]}`;
  }
  return formatPrice(minor, { currency: code });
}

/**
 * A money amount as HTML for a printed document, with Arabic placement: the locale's symbol («ج.م», never
 * "EGP" in Arabic) and, when `sign` is given, the sign isolated left-to-right WITH its number so an RTL
 * paragraph cannot paint it after the digits ("20-"). Same rule as the storefront's `<SignedAmount>`:
 * only the sign and the number are isolated; the currency keeps the position every unsigned price has.
 * Escaped; safe to interpolate.
 */
export function moneyHtml(
  minor: number,
  currency: string | null | undefined,
  locale: 'en' | 'ar',
  sign?: '\u2212'
): string {
  const text = emailMoney(minor, currency, locale);
  const m = /[0-9](?:[0-9.,]*[0-9])?/.exec(text);
  if (!m) return `<span dir="ltr">${escapeHtml(text)}</span>`;
  const before = escapeHtml(text.slice(0, m.index));
  const after = escapeHtml(text.slice(m.index + m[0].length));
  const num = `<bdi dir="ltr">${sign ?? ''}${escapeHtml(m[0])}</bdi>`;
  return `<span style="white-space:nowrap">${before}${num}${after}</span>`;
}
