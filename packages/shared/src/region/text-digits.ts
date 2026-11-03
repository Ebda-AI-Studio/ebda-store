/**
 * Merchant-authored storefront copy (product titles, hero headlines, section headings) -> one numeral
 * system and bidi-safe numbers (storefront audit 2026-11-03 #12, Ruling PREMIUM-12).
 *
 * DIGITS-1 makes Western digits the only system, but copy a merchant TYPED can still carry Arabic-Indic
 * digits ("٣٠٪ خصم") next to the Western digits of prices. `westernizeDigits` folds them (and the Arabic
 * percent, decimal and thousands marks) into Western. `isolateNumbers` then wraps each number (with its
 * % sign or unit-less decimals) in a left-to-right isolate so a title such as "سيروم فيتامين سي 15% 30 مل"
 * does not reorder to "30 %15" inside right-to-left text. Idempotent. Text with no digit is returned as is.
 */
const ARABIC_INDIC = /[٠-٩۰-۹]/g;
const LRI = '⁦';
const PDI = '⁩';
// 15%  1,490.50  3.5  (a number plus an optional percent sign)
const NUMBER_RUN = /(?<![⁦\w])(\d+(?:[.,]\d+)*)(\s?%)?(?![\w⁩])/g;

export function westernizeDigits(text: string): string {
  if (!text) return text;
  return text
    .replace(ARABIC_INDIC, d => String(d.charCodeAt(0) & 0xf))
    .replace(/٪/g, '%')
    .replace(/٫/g, '.')
    .replace(/٬/g, ',');
}

export function isolateNumbers(text: string): string {
  if (!text || !/\d/.test(text) || text.includes(LRI)) return text;
  return text.replace(
    NUMBER_RUN,
    (_m, num: string, pct?: string) => `${LRI}${num}${pct ?? ''}${PDI}`
  );
}

/** The one call storefront copy goes through. */
export function storefrontText(text: string | null | undefined, isRtl: boolean): string {
  if (!text) return text ?? '';
  const w = westernizeDigits(text);
  return isRtl ? isolateNumbers(w) : w;
}
