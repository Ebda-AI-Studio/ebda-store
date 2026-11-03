// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatNumber, formatPrice } from '../format';
import { NON_LATIN_NUMERAL } from '../../i18n/numerals';

/**
 * Audit G-5: an Arabic admin showed "Oct 10, 2026" and "EGP 0.00". Dates, numbers and money follow the UI language,
 * and digits stay Western in both (Ruling NUMERALS-1).
 */
afterEach(() => {
  document.documentElement.lang = '';
});

describe('Arabic UI', () => {
  it('formats a date with Arabic month names and Western digits', () => {
    document.documentElement.lang = 'ar';
    const out = formatDate('2026-10-10T12:00:00Z');
    expect(out).toMatch(/أكتوبر/);
    expect(out).toMatch(/2026/);
    expect(NON_LATIN_NUMERAL.test(out)).toBe(false);
    expect(out).not.toMatch(/Oct/);
  });

  it('formats date-time with an Arabic month and Western digits', () => {
    document.documentElement.lang = 'ar';
    const out = formatDateTime('2026-10-25T15:05:00Z');
    expect(out).toMatch(/أكتوبر/);
    expect(NON_LATIN_NUMERAL.test(out)).toBe(false);
  });

  it('formats money with the Arabic currency symbol, not "EGP"', () => {
    document.documentElement.lang = 'ar';
    const out = formatPrice(0);
    expect(out).toMatch(/ج\.م/);
    expect(out).not.toMatch(/EGP/);
    expect(out).toMatch(/0\.00/);
    expect(formatPrice(150000)).toMatch(/1,500\.00/);
  });

  it('formats a count with Western digits', () => {
    document.documentElement.lang = 'ar';
    const out = formatNumber(1234567);
    expect(NON_LATIN_NUMERAL.test(out)).toBe(false);
    expect(out).toMatch(/1.234.567/);
  });
});

describe('English UI keeps its format', () => {
  it('en date, money', () => {
    document.documentElement.lang = 'en';
    expect(formatDate('2026-10-10T12:00:00Z')).toBe('Oct 10, 2026');
    expect(formatPrice(45000)).toMatch(/EGP/);
    expect(formatNumber(1234)).toBe('1,234');
  });
  it('null date is a dash in both', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDateTime(undefined)).toBe('—');
  });
});
