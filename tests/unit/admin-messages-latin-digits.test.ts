/**
 * Ruling NUMERALS-1: the admin uses Western digits (0-9) and the Western percent sign in both
 * languages. Arabic-Indic (٠-٩) or extended (۰-۹) digits, or the Arabic percent sign (٪), in an
 * admin message file are a regression, except where the copy SHOWS the storefront's
 * Arabic-Indic option itself. The character class lives in ONE place, `i18n/numerals.ts`.
 */
import { describe, it, expect } from 'vitest';
import ar from '../../apps/admin/src/i18n/messages/ar.json';
import en from '../../apps/admin/src/i18n/messages/en.json';
import { NON_LATIN_NUMERAL as NON_LATIN_DIGIT } from '../../apps/admin/src/i18n/numerals';

type Messages = { [key: string]: string | Messages };
function flatten(obj: Messages, prefix = '', out: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v as Messages, key, out);
    else out[key] = v as string;
  }
  return out;
}

/** These name the ١٢٣ storefront option; showing the digits is the point. */
// Retired with the per-store opt-in (Ruling DIGITS-1): no admin message may show an Arabic-Indic digit, no exceptions.
const SHOWS_THE_OPTION = new Set<string>();

describe('admin message files use Western digits (NUMERALS-1)', () => {
  it.each([
    ['ar', ar],
    ['en', en],
  ])('%s.json', (_lang, messages) => {
    const offenders = Object.entries(flatten(messages as Messages))
      .filter(([k, v]) => !SHOWS_THE_OPTION.has(k) && NON_LATIN_DIGIT.test(v))
      .map(([k]) => k);
    expect(offenders).toEqual([]);
  });

  it('the shared class covers both digit blocks and the Arabic percent sign', () => {
    for (const c of ['٠', '٩', '۰', '۹', '٪']) expect(NON_LATIN_DIGIT.test(c), c).toBe(true);
    for (const c of ['0', '9', '%', '٫']) expect(NON_LATIN_DIGIT.test(c), c).toBe(false);
  });

  it('there is no allowlist any more (DIGITS-1)', () => {
    expect(SHOWS_THE_OPTION.size).toBe(0);
  });
});
