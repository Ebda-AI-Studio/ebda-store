import { describe, expect, it } from 'vitest';
import {
  sizeChartSchema,
  sizeChartColumnLabel,
  sizeChartName,
  sizeChartNote,
  toPublicSizeChart,
} from '@ebda/shared';

const base = {
  name: 'Abaya',
  nameAr: 'عباية',
  unit: 'cm',
  columns: [
    { label: 'Size', labelAr: 'المقاس' },
    { label: 'Length', labelAr: 'الطول' },
  ],
  rows: [
    ['S', '52'],
    ['M', '54'],
  ],
  note: '',
  noteAr: '',
};

describe('sizeChartSchema', () => {
  it('accepts a rectangular chart', () =>
    expect(sizeChartSchema.safeParse(base).success).toBe(true));
  it('rejects ragged rows', () =>
    expect(sizeChartSchema.safeParse({ ...base, rows: [['S']] }).success).toBe(false));
  it('needs a name in one language', () => {
    expect(sizeChartSchema.safeParse({ ...base, name: '', nameAr: '' }).success).toBe(false);
    expect(sizeChartSchema.safeParse({ ...base, name: '  ', nameAr: '' }).success).toBe(false);
    expect(sizeChartSchema.safeParse({ ...base, name: '' }).success).toBe(true);
  });
  it('caps rows at 30', () =>
    expect(
      sizeChartSchema.safeParse({ ...base, rows: Array.from({ length: 31 }, () => ['S', '1']) })
        .success
    ).toBe(false));
  it('needs 2..10 columns', () => {
    const cols = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ label: `c${i}`, labelAr: '' }));
    expect(sizeChartSchema.safeParse({ ...base, columns: cols(1), rows: [['S']] }).success).toBe(
      false
    );
    expect(
      sizeChartSchema.safeParse({ ...base, columns: cols(11), rows: [Array(11).fill('1')] }).success
    ).toBe(false);
    expect(
      sizeChartSchema.safeParse({ ...base, columns: cols(10), rows: [Array(10).fill('1')] }).success
    ).toBe(true);
  });
  it('caps a cell at 24 characters and trims it', () => {
    expect(sizeChartSchema.safeParse({ ...base, rows: [['S', 'x'.repeat(25)]] }).success).toBe(
      false
    );
    const ok = sizeChartSchema.parse({ ...base, rows: [['  S ', '52']] });
    expect(ok.rows[0][0]).toBe('S');
  });
  it('rejects an unknown unit and defaults to cm', () => {
    expect(sizeChartSchema.safeParse({ ...base, unit: 'mm' }).success).toBe(false);
    const { unit: _unit, ...noUnit } = base;
    expect(sizeChartSchema.parse(noUnit).unit).toBe('cm');
  });
});

describe('size chart text', () => {
  const arOnly = sizeChartSchema.parse({
    ...base,
    name: '',
    columns: [
      { label: '', labelAr: 'المقاس' },
      { label: 'Length', labelAr: '' },
    ],
    noteAr: 'القياسات بالسنتيمتر',
  });
  it('falls back to arabic in english', () => {
    expect(sizeChartName(arOnly, 'en')).toBe('عباية');
    expect(sizeChartColumnLabel(arOnly.columns[0], 'en')).toBe('المقاس');
    expect(sizeChartNote(arOnly, 'en')).toBe('القياسات بالسنتيمتر');
  });
  it('falls back to english in arabic', () => {
    expect(sizeChartColumnLabel(arOnly.columns[1], 'ar')).toBe('Length');
  });
  it('prefers the active language', () => {
    expect(sizeChartName(sizeChartSchema.parse(base), 'en')).toBe('Abaya');
    expect(sizeChartName(sizeChartSchema.parse(base), 'ar')).toBe('عباية');
  });
});

describe('toPublicSizeChart', () => {
  it('keeps the id of a valid row', () =>
    expect(toPublicSizeChart({ id: 'c1', ...base })?.id).toBe('c1'));
  it('returns null for null, a missing id, or a malformed row', () => {
    expect(toPublicSizeChart(null)).toBeNull();
    expect(toPublicSizeChart(base)).toBeNull();
    expect(toPublicSizeChart({ id: 'c1', ...base, rows: [['S']] })).toBeNull();
  });
});
