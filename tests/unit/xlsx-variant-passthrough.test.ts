/**
 * Unit tests: the xlsx->csv converter must NOT drop variant rows (which have
 * no name) and must pass the variant columns through, with EGP->piastres on price.
 */
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { xlsxBufferToImportCsv } from '../../apps/api/src/services/xlsx-import';

async function sheetToBuffer(rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('products');
  rows.forEach(r => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const header = ['name', 'sku', 'price', 'parentSku', 'option1Name', 'option1Value'];

describe('xlsx variant passthrough', () => {
  it('keeps a variant row that has no name (parentSku present)', async () => {
    const buf = await sheetToBuffer([
      header,
      ['Dates', 'D1', '3.5', '', '', ''],
      ['', 'D1-1kg', '4.5', 'D1', 'Size', '1 Kg'],
    ]);
    const csv = await xlsxBufferToImportCsv(buf);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(3); // header + 2 data rows (variant NOT dropped)
    expect(csv).toContain('D1-1kg');
    expect(csv).toContain('1 Kg');
  });

  it('converts variant price EGP -> piastres', async () => {
    const buf = await sheetToBuffer([header, ['', 'D1-1kg', '4.5', 'D1', 'Size', '1 Kg']]);
    const csv = await xlsxBufferToImportCsv(buf);
    expect(csv).toContain('450'); // 4.5 EGP -> 450 piastres
  });

  it('REJECTS a price with more than 2 decimals instead of rounding it (row carries a PRICE_* _error)', async () => {
    const buf = await sheetToBuffer([header, ['Item', 'S1', '1.999', '', '', '']]);
    const csv = await xlsxBufferToImportCsv(buf);
    expect(csv).toContain('PRICE_AMBIGUOUS_DECIMALS');
    expect(csv).not.toContain('199,');
    expect(csv).not.toContain('200,');
  });

  it('still drops a truly empty/nameless row with no parentSku', async () => {
    const buf = await sheetToBuffer([
      header,
      ['Dates', 'D1', '3.5', '', '', ''],
      ['', '', '', '', '', ''],
    ]);
    const csv = await xlsxBufferToImportCsv(buf);
    expect(csv.trim().split('\n')).toHaveLength(2); // header + the one real row
  });
});
