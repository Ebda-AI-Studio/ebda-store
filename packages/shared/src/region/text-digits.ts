/**
 * Merchant-authored storefront copy (product titles, hero headlines, section headings) -> one numeral
 * system and bidi-safe numbers (storefront audit 2026-11-03 #12, Ruling PREMIUM-12).
 *
 * DIGITS-1 makes Western digits the only system, but copy a merchant TYPED can still carry Arabic-Indic
 * digits (an Arabic-Indic "30%") next to the Western digits of prices. `westernizeDigits` folds them (and the Arabic
 * percent, decimal and thousands marks) into Western. `isolateNumbers` then wraps each number (with its
 * % sign or unit-less decimals) in a left-to-right isolate so a title such as "سيروم فيتامين سي 15% 30 مل"
 * does not reorder to "30 %15" inside right-to-left text. Idempotent. Text with no digit is returned as is.
 */
const ARABIC_INDIC = new RegExp(String.raw`[\u0660-\u0669\u06F0-\u06F9]`, 'g');
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);
// 15%  1,490.50  3.5  (a number plus an optional percent sign)
const NUMBER_RUN = new RegExp(
  String.raw`(?<![\u2066\w])(\d+(?:[.,]\d+)*)(\s?%)?(?![\w\u2069])`,
  'g'
);

export function westernizeDigits(text: string): string {
  if (!text) return text;
  return text
    .replace(ARABIC_INDIC, d => String(d.charCodeAt(0) & 0xf))
    .replace(/\u066A/g, '%')
    .replace(/\u066B/g, '.')
    .replace(/\u066C/g, ',');
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
