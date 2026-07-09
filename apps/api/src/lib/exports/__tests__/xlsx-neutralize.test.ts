import { describe, it, expect } from 'vitest';
import { neutralizeCell, neutralizeRowObject, neutralizeRowArray } from '../xlsx';

/**
 * Formula-injection guard for hand-built ExcelJS exports (orders, customers,
 * shipping). A cell beginning with `= + - @` (or tab/CR) can execute as a
 * spreadsheet formula when the .xlsx is opened in Excel / Google Sheets; the
 * guard prefixes a single quote to make the leading char inert. Numbers and
 * dates must pass through untouched so they stay numeric/sortable.
 */
describe('xlsx neutralize helpers', () => {
  describe('neutralizeCell', () => {
    it.each(['=SUM(A1:A9)', '+1+1', '-2+3', '@import', '\tcmd', '\rcmd'])(
      'prefixes a quote on formula-triggering string %j',
      dangerous => {
        expect(neutralizeCell(dangerous)).toBe(`'${dangerous}`);
      }
    );

    it('leaves ordinary strings untouched', () => {
      expect(neutralizeCell('Ahmad Sharaf')).toBe('Ahmad Sharaf');
      expect(neutralizeCell('')).toBe('');
    });

    it('passes non-string values through unchanged (numbers/dates stay sortable)', () => {
      const d = new Date('2026-07-09T00:00:00Z');
      expect(neutralizeCell(42)).toBe(42);
      expect(neutralizeCell(0)).toBe(0);
      expect(neutralizeCell(d)).toBe(d);
      expect(neutralizeCell(null)).toBeNull();
      expect(neutralizeCell(undefined)).toBeUndefined();
    });
  });

  describe('neutralizeRowObject', () => {
    it('neutralizes only the string cells in an addRow object payload', () => {
      expect(
        neutralizeRowObject({
          customerNotes: '=cmd|/c calc',
          product: 'Normal Widget',
          total: 12.5,
          orderDate: new Date('2026-07-09T00:00:00Z'),
        })
      ).toMatchObject({
        customerNotes: "'=cmd|/c calc",
        product: 'Normal Widget',
        total: 12.5,
      });
    });
  });

  describe('neutralizeRowArray', () => {
    it('neutralizes only the string cells in an addRow array payload', () => {
      expect(neutralizeRowArray(['@evil', 'Safe Product', 3, 9.75])).toEqual([
        "'@evil",
        'Safe Product',
        3,
        9.75,
      ]);
    });
  });
});
