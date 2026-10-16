/**
 * Ruling NUMERALS-1: the admin uses Western digits (0-9) in both languages. Arabic-Indic
 * (٠-٩) or extended (۰-۹) digits in an admin message file are a regression, except where the
 * copy SHOWS the storefront's Arabic-Indic option itself.
 */
import { describe, it, expect } from 'vitest';
import ar from '../../apps/admin/src/i18n/messages/ar.json';
import en from '../../apps/admin/src/i18n/messages/en.json';

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
const SHOWS_THE_OPTION = new Set([
  'branding.theme.arabicNumerals.title',
  'branding.theme.arabicNumerals.hint',
  'branding.theme.arabicNumerals.arabic',
]);
const NON_LATIN_DIGIT = /[٠-٩۰-۹]/;

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

  it('the allowlist is still needed (a stale entry fails)', () => {
    const flat = flatten(ar as Messages);
    for (const k of SHOWS_THE_OPTION) expect(NON_LATIN_DIGIT.test(flat[k])).toBe(true);
  });
});
