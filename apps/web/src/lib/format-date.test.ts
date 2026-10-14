import { describe, it, expect } from 'vitest';
import { formatDate } from './format-date';

// Wed 21 Oct 2026, 13:00 in Cairo.
const d = new Date('2026-10-21T10:00:00Z');

describe('formatDate day preset (delivery window)', () => {
  it('english is weekday day month, no comma, no year', () => {
    expect(formatDate(d, { style: 'day', language: 'en' })).toBe('Wed 21 Oct');
  });
  it('arabic has no comma after the weekday and keeps the chosen digits', () => {
    const latn = formatDate(d, { style: 'day', language: 'ar', numerals: 'latn' });
    expect(latn).toBe('الأربعاء 21 أكتوبر');
    expect(latn).not.toMatch(/[,،]/);
    expect(formatDate(d, { style: 'day', language: 'ar', numerals: 'arab' })).toBe(
      'الأربعاء ٢١ أكتوبر'
    );
  });
  it('reads the day in the store timezone and survives a bad zone', () => {
    const late = new Date('2026-10-21T22:30:00Z'); // already Thu 22 in Cairo
    expect(formatDate(late, { style: 'day', language: 'en', timezone: 'Africa/Cairo' })).toBe(
      'Thu 22 Oct'
    );
    expect(formatDate(late, { style: 'day', language: 'en', timezone: 'Not/AZone' })).toBe(
      'Thu 22 Oct'
    );
  });
});

describe('formatDate medium preset (receipt date)', () => {
  it('english is day month year, never month-first', () => {
    expect(formatDate(d, { style: 'medium', language: 'en' })).toBe('21 Oct 2026');
  });
  it('arabic keeps western digits by default and arabic-indic when the store opts in', () => {
    expect(formatDate(d, { style: 'medium', language: 'ar' })).toBe('21 أكتوبر 2026');
    expect(formatDate(d, { style: 'medium', language: 'ar', numerals: 'arab' })).toBe(
      '٢١ أكتوبر ٢٠٢٦'
    );
  });
});
