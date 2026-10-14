import { describe, expect, it } from 'vitest';
import { sizeChartSchema, SIZE_CHART_MAX_COLUMNS, SIZE_CHART_MAX_ROWS } from '@ebda/shared';
import {
  EMPTY_SIZE_CHART,
  SIZE_CHART_TEMPLATES,
  addColumn,
  addRow,
  removeColumn,
  removeRow,
} from './SizeChartEditor';

describe('size chart editor', () => {
  it('every template is a valid chart with Latin digits (admin NUMERALS-1)', () => {
    for (const [key, tpl] of Object.entries(SIZE_CHART_TEMPLATES)) {
      expect(sizeChartSchema.safeParse(tpl).success, key).toBe(true);
      expect(JSON.stringify(tpl.rows), key).not.toMatch(/[٠-٩]/);
    }
  });

  it('the three templates the brief names, in Arabic', () => {
    expect(Object.values(SIZE_CHART_TEMPLATES).map(t => t.nameAr)).toEqual([
      'عباية',
      'ملابس',
      'مقاس الخاتم',
    ]);
  });

  it('adding/removing a column keeps every row rectangular', () => {
    let c = addColumn(EMPTY_SIZE_CHART);
    expect(c.columns).toHaveLength(3);
    expect(c.rows.every(r => r.length === 3)).toBe(true);
    c = removeColumn({ ...c, rows: [['a', 'b', 'c']] }, 1);
    expect(c.rows).toEqual([['a', 'c']]);
  });

  it('respects the limits: 2..10 columns, 1..30 rows', () => {
    expect(removeColumn(EMPTY_SIZE_CHART, 0)).toBe(EMPTY_SIZE_CHART);
    expect(removeRow(EMPTY_SIZE_CHART, 0)).toBe(EMPTY_SIZE_CHART);
    let c = EMPTY_SIZE_CHART;
    for (let i = 0; i < 20; i++) c = addColumn(c);
    expect(c.columns).toHaveLength(SIZE_CHART_MAX_COLUMNS);
    for (let i = 0; i < 40; i++) c = addRow(c);
    expect(c.rows).toHaveLength(SIZE_CHART_MAX_ROWS);
    expect(c.rows.every(r => r.length === SIZE_CHART_MAX_COLUMNS)).toBe(true);
  });
});
