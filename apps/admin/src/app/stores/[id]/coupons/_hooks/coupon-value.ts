/**
 * The coupon form's discount value, as typed.
 *
 * QA-COUPON-1 root cause: the value input was `type="number"` bound to a NUMBER with `parseFloat(raw) || 0`. A browser
 * hands back "" for anything it cannot parse as a number (Arabic-Indic digits typed on an Arabic keyboard, the Arabic
 * decimal mark, a half-typed "2."), and `|| 0` turned that into a quiet 0: the field then SHOWED 0, still satisfied
 * `required`, and the coupon saved as a 0% coupon without a word. The form now keeps the raw text, converts Arabic-Indic
 * and Persian digits and the Arabic decimal mark to Latin, and never invents a 0: an unreadable value stays NaN and is
 * sent as 0, which the API refuses with a clear message (COUPON_VALUE_REQUIRED).
 */
const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';

export function normalizeNumberText(raw: string): string {
  return raw
    .replace(/[٠-٩]/g, d => String(ARABIC_INDIC.indexOf(d)))
    .replace(/[۰-۹]/g, d => String(PERSIAN.indexOf(d)))
    .replace(/[٫,،]/g, '.')
    .replace(/\s+/g, '')
    .trim();
}

/** The typed value as a number, or NaN when it is empty or not a number. Never 0 by default. */
export function parseCouponValue(raw: string): number {
  const t = normalizeNumberText(raw);
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : Number.NaN;
}
