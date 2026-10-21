import { normalizeArabicSearch } from './arabic-normalize';

/**
 * The digits to look for in a phone number typed in ANY form (+20 / 0020 / 01x / spaces / Arabic-Indic
 * digits), to be matched against `public.ebda_digits(phone)` with a `LIKE '%…%'`. The country prefix
 * and the trunk 0 are dropped when a full national number remains, so "+20 101 234 5678" and
 * "01012345678" both find a number stored either way. A partial number is matched as typed.
 * Null when fewer than 4 digits (too short to be a phone search, and below a trigram).
 */
export function phoneSearchDigits(q: string): string | null {
  const digits = normalizeArabicSearch(q ?? '').replace(/[^0-9]/g, '');
  if (digits.length < 4) return null;
  const national = digits.replace(/^(?:0020|20|0)/, '');
  return national.length >= 9 ? national : digits;
}
