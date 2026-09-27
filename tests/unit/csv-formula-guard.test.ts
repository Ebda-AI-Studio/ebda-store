/**
 * csvField / neutralizeFormula — the one CSV-injection guard every exporter
 * shares (packages/shared/src/csv-utils.ts).
 *
 * #811: finance exports format amounts with filsToKwd ("-1.500"), and the
 * guard prefixed every negative amount with a quote, so spreadsheets imported
 * it as text and SUM() skipped it. A cell that is entirely a number is now
 * left alone — and every injection payload, including ones that START like a
 * number, is still neutralised.
 */
import { describe, it, expect } from 'vitest';
import { csvField, neutralizeFormula } from '../../packages/shared/src/csv-utils';

describe('neutralizeFormula', () => {
  it.each(['-1.500', '+3.2', '-0', '12', '0.250', '-1234567.125'])(
    'leaves the plain number %s numeric (#811)',
    n => {
      expect(neutralizeFormula(n)).toBe(n);
    }
  );

  it.each([
    '=1+1',
    '=HYPERLINK("http://evil","x")',
    '+SUM(A1:A9)',
    "-1+cmd|' /C calc'!A0",
    '-2+3',
    '+1-1',
    '-1.5e3',
    '-cmd',
    '@SUM(A1)',
    '\t=1+1',
    '\r=1+1',
    '-',
    '+',
    '- 1',
  ])('neutralises the formula payload %j', payload => {
    expect(neutralizeFormula(payload)).toBe(`'${payload}`);
  });

  it('leaves ordinary text alone', () => {
    expect(neutralizeFormula('Rent — May')).toBe('Rent — May');
  });
});

describe('csvField', () => {
  it('exports a negative KWD amount as a bare number', () => {
    expect(csvField('-1.500')).toBe('-1.500');
  });

  it('still neutralises and quotes a payload that needs both', () => {
    expect(csvField('=1+1,"x"')).toBe(`"'=1+1,""x"""`);
  });

  it('handles null, numbers and dates', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(-1.5)).toBe('-1.5');
    expect(csvField(new Date('2026-09-25T00:00:00.000Z'))).toBe('2026-09-25T00:00:00.000Z');
  });
});
