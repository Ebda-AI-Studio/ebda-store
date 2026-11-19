import { describe, it, expect } from 'vitest';
import { buildImportPreview, mergeImportCheckErrors } from './import-preview';
import { parentKeyFor } from './bulk.service';

const csv = ['name,sku,price,parentSku', 'A,A-1,1000,', 'B,B-1,2000,', ',,500,A-1'].join('\n');

describe('mergeImportCheckErrors (STORE-QA-64)', () => {
  it('a clean dry run leaves the preview green', () => {
    const p = mergeImportCheckErrors(buildImportPreview(csv), []);
    expect(p.invalidRows).toBe(0);
    expect(p.validRows).toBe(3);
  });
  it('importer row errors turn the preview red instead of "3 of 3 ready"', () => {
    const base = buildImportPreview(csv);
    const p = mergeImportCheckErrors(base, [
      { row: 2, error: 'Barcode "1" already belongs to another product in this store' },
      { row: 4, error: 'Name is required' },
    ]);
    expect(p.invalidRows).toBe(2);
    expect(p.validRows).toBe(1);
    expect(p.errors.map(e => e.row)).toEqual([2, 4]);
    expect(p.rows.find(r => r.row === 2)?.error).toMatch(/already belongs/);
  });
  it('a group-level error (row 0) counts once and a row already failing is not double counted', () => {
    const p = mergeImportCheckErrors(buildImportPreview(csv), [
      { row: 0, error: 'Variant parent sku not found' },
      { row: 2, error: 'x' },
      { row: 2, error: 'x' },
    ]);
    expect(p.invalidRows).toBe(2);
  });
});

describe('parentKeyFor', () => {
  it('uses the sku, else slug:<slug>', () => {
    expect(parentKeyFor('SKU-1', 'a-b')).toBe('SKU-1');
    expect(parentKeyFor(null, 'a-b')).toBe('slug:a-b');
    expect(parentKeyFor('  ', 'a-b')).toBe('slug:a-b');
  });
});
