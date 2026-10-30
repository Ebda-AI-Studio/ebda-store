import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Ruling BUNDLE-BUDGET-6: the API Worker bundles a build of exceljs' own lib/ source with the Node built-ins left to
// nodejs_compat (scripts/ci/gen-exceljs-workers.mjs). It must be the same library: a workbook written by one is read by the
// other and comes back equal, including the sheet-protection hash (the one place exceljs uses `crypto`).
const require_ = createRequire(import.meta.url);
const ROOT = join(__dirname, '../../..');
const stock = require_('exceljs');
const workers = require_(join(ROOT, 'apps/api/src/cf/stubs/exceljs-workers.cjs'));

async function sample(ExcelJS: any) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ebda';
  const ws = wb.addWorksheet('Orders', { views: [{ rightToLeft: true }] });
  ws.columns = [
    { header: 'رقم', key: 'n', width: 12 },
    { header: 'Total', key: 't', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Note', key: 'note', width: 30 },
  ];
  ws.addRow({
    n: 'ORD-1',
    t: 1234.5,
    note: { richText: [{ text: 'bold ', font: { bold: true } }, { text: 'plain' }] },
  });
  ws.addRow({ n: 'ORD-2', t: { formula: 'B2*2', result: 2469 }, note: 'مرحبا' });
  ws.getCell('C3').value = new Date(Date.UTC(2026, 9, 30));
  ws.getRow(1).font = { bold: true };
  ws.mergeCells('A5:C5');
  ws.getCell('A5').value = 'merged';
  return wb;
}
const dump = (wb: any) =>
  wb.worksheets.map((ws: any) => ({
    name: ws.name,
    rtl: ws.views?.[0]?.rightToLeft ?? false,
    rows: ws.getSheetValues().map((r: any) => JSON.parse(JSON.stringify(r ?? null))),
    merges: Object.keys(ws._merges ?? {}).sort(),
  }));

describe('exceljs build for the Workers bundle', () => {
  it('was built from the installed exceljs', () => {
    const head = readFileSync(
      join(ROOT, 'apps/api/src/cf/stubs/exceljs-workers.cjs'),
      'utf8'
    ).slice(0, 40);
    expect(head).toContain(`exceljs@${require_('exceljs/package.json').version} `);
  });

  it('exposes exactly the surface of the build the Worker used before (dist/exceljs.bare.min.js)', () => {
    const before = require_('exceljs/dist/exceljs.bare.min.js');
    expect(Object.keys(workers).sort()).toEqual(Object.keys(before).sort());
  });

  it('writes a workbook the stock library reads back equal, and the reverse', async () => {
    const a = await sample(workers);
    const b = await sample(stock);
    const bufA = Buffer.from(await a.xlsx.writeBuffer());
    const bufB = Buffer.from(await b.xlsx.writeBuffer());
    const readByStock = new stock.Workbook();
    await readByStock.xlsx.load(bufA);
    const readByWorkers = new workers.Workbook();
    await readByWorkers.xlsx.load(bufB);
    expect(dump(readByStock)).toEqual(dump(b));
    expect(dump(readByWorkers)).toEqual(dump(b));
    expect(dump(readByWorkers)[0].rows.length).toBeGreaterThan(3);
  });

  it('sheet protection (the crypto path) writes a salted SHA-512 hash and survives a round trip', async () => {
    const wb = await sample(workers);
    await wb.worksheets[0].protect('s3cret', { selectLockedCells: true });
    const back = new stock.Workbook();
    await back.xlsx.load(Buffer.from(await wb.xlsx.writeBuffer()));
    const sp = back.worksheets[0].sheetProtection;
    expect(sp.algorithmName).toBe('SHA-512');
    expect(sp.hashValue).toMatch(/^[A-Za-z0-9+/=]{80,}$/);
    expect(sp.saltValue).toMatch(/^[A-Za-z0-9+/=]{16,}$/);
  });
});
