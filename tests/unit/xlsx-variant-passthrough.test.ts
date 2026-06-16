/**
 * Unit tests: the xlsx->csv converter must NOT drop variant rows (which have
 * no name) and must pass the variant columns through, with KWD->fils on price.
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

  it('converts variant price KWD -> fils', async () => {
    const buf = await sheetToBuffer([header, ['', 'D1-1kg', '4.5', 'D1', 'Size', '1 Kg']]);
    const csv = await xlsxBufferToImportCsv(buf);
    expect(csv).toContain('4500'); // 4.5 KWD -> 4500 fils
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
