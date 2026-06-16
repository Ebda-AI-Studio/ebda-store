/**
 * Unit tests for the OSOSS variant-import pure helpers in bulk.service:
 * classifyRow, collectOptions, buildVariantTitle. No DB — pure functions.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyRow,
  collectOptions,
  buildVariantTitle,
  BulkService,
  type VariantImportRow,
} from '../../apps/api/src/services/bulk.service';

describe('classifyRow', () => {
  it('treats an empty/absent parentSku as a base row', () => {
    expect(classifyRow({ parentSku: '' })).toBe('base');
    expect(classifyRow({})).toBe('base');
    expect(classifyRow({ parentSku: '   ' })).toBe('base');
  });
  it('treats a non-empty parentSku as a variant row', () => {
    expect(classifyRow({ parentSku: 'D1' })).toBe('variant');
  });
});

describe('collectOptions', () => {
  it('dedupes option values across variant rows, preserving first-seen order', () => {
    const variants: VariantImportRow[] = [
      { parentSku: 'P', sku: 'P-1kg', option1Name: 'Size', option1Value: '1 Kg' },
      { parentSku: 'P', sku: 'P-500g', option1Name: 'Size', option1Value: '500 Gram' },
      { parentSku: 'P', sku: 'P-1kg-2', option1Name: 'Size', option1Value: '1 Kg' },
    ];
    expect(collectOptions(variants)).toEqual([{ name: 'Size', values: ['1 Kg', '500 Gram'] }]);
  });
  it('supports up to three option axes in declaration order', () => {
    const v: VariantImportRow[] = [
      {
        parentSku: 'P',
        sku: 'x',
        option1Name: 'Size',
        option1Value: 'S',
        option2Name: 'Color',
        option2Value: 'Red',
      },
    ];
    expect(collectOptions(v).map(o => o.name)).toEqual(['Size', 'Color']);
  });
  it('ignores option pairs missing a name or value', () => {
    const v: VariantImportRow[] = [
      { parentSku: 'P', option1Name: 'Size', option1Value: '' },
      { parentSku: 'P', option1Name: '', option1Value: '1 Kg' },
    ];
    expect(collectOptions(v)).toEqual([]);
  });
});

describe('buildVariantTitle', () => {
  it('joins option values with " / "', () => {
    expect(buildVariantTitle(['1 Kg'])).toBe('1 Kg');
    expect(buildVariantTitle(['S', 'Red'])).toBe('S / Red');
  });
});

describe('splitCsvRecords', () => {
  it('keeps a quoted field with an embedded newline as ONE record', () => {
    const csv = 'name,description\n' + 'Honey,"line one\nline two"\n' + 'Dates,plain';
    const records = BulkService.splitCsvRecords(csv);
    expect(records).toHaveLength(3); // header + 2 products (NOT 4)
    expect(records[1]).toBe('Honey,"line one\nline two"');
    expect(records[2]).toBe('Dates,plain');
  });
  it('handles CRLF line endings and a trailing newline', () => {
    expect(BulkService.splitCsvRecords('a,b\r\nc,d\r\n')).toEqual(['a,b', 'c,d']);
  });
  it('does not split on a newline inside escaped quotes', () => {
    const csv = 'name\n"a ""quoted""\nvalue"';
    expect(BulkService.splitCsvRecords(csv)).toEqual(['name', '"a ""quoted""\nvalue"']);
  });
});
