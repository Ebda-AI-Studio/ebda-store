import { describe, expect, it } from 'vitest';
// @ts-expect-error plain CommonJS build, no types
import ExcelJS from '../src/cf/modules/exceljs.cjs';

// Ruling BUNDLE-BUDGET-6: the exceljs the Worker bundles leaves crypto/events/buffer/stream to nodejs_compat. On real workerd it
// must still write and read a workbook and hash a protected sheet.
describe('exceljs build on workerd', () => {
  it('writes a workbook with RTL text, a formula and a protected sheet, and reads it back', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('طلبات', { views: [{ rightToLeft: true }] });
    ws.addRow(['ORD-1', 1234.5, 'مرحبا']);
    ws.addRow(['ORD-2', { formula: 'B1*2', result: 2469 }, 'x']);
    await ws.protect('s3cret', {});
    const buf = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
    expect(buf.byteLength).toBeGreaterThan(1000);
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(buf);
    const w2 = back.worksheets[0];
    expect(w2.name).toBe('طلبات');
    expect(w2.getCell('B1').value).toBe(1234.5);
    expect(w2.getCell('C1').value).toBe('مرحبا');
    expect(w2.sheetProtection.algorithmName).toBe('SHA-512');
    expect(String(w2.sheetProtection.hashValue).length).toBeGreaterThan(60);
  });
});
