/**
 * Ruling NUMERALS-1: the admin writes numbers with Western digits (0-9) and the
 * Western percent sign in both languages. The ONE regex every admin numeral
 * check reads (message files and rendered ICU output alike), so the message-file
 * gate and the render check cannot drift apart:
 *   - Arabic-Indic digits ٠-٩ (U+0660-0669) and extended ۰-۹ (U+06F0-06F9);
 *   - the Arabic percent sign ٪ (U+066A), which reads as a mixed numeral next
 *     to a Western digit ("20٪"): the Western `%` is the admin's form.
 * The Arabic decimal separator ٫ is not in it: `Intl` may emit it for a price.
 */
export const NON_LATIN_NUMERAL = /[٠-٩۰-۹٪]/;
