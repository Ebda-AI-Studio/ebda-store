/**
 * Product-import price units. Merchants type EGP ("250", "250.50"); the
 * importer stores integer piastres. Covers the shared cell parser, the
 * platform-CSV / XLSX / Shopify converters, the dry-run preview, and the
 * template + export round trip (an exported file must re-import to the same
 * prices). Pure unit tests — no database.
 */
import { describe, it, expect, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { prisma } from '@ebda/database';
import { parsePriceCell } from '../../apps/api/src/services/price-cell';
import { importCsvToPlatformCsv, parseCsvRecords } from '../../apps/api/src/services/csv-import';
import { xlsxBufferToImportCsv } from '../../apps/api/src/services/xlsx-import';
import { buildImportPreview } from '../../apps/api/src/services/import-preview';
import { BulkService } from '../../apps/api/src/services/bulk.service';

const minor = (raw: string, required = false) => {
  const r = parsePriceCell(raw, { required });
  return r.ok ? r.minor : r.code;
};

describe('parsePriceCell', () => {
  it.each([
    ['250', 25000],
    ['250.5', 25050],
    ['250.50', 25050],
    ['1,250.50', 125050],
    ['12,500', 1250000],
    ['٢٥٠٫٥٠', 25050],
    ['۲۵۰.۵', 25050],
    ['1٬250٫50', 125050],
    ['0.05', 5],
    ['12.5000', 1250], // trailing zeros lose nothing
    ['  99  ', 9900],
  ])('accepts %s -> %i piastres', (raw, expected) => {
    expect(minor(raw)).toBe(expected);
  });

  it('rejects 3-decimal values as ambiguous (Kuwaiti habit / thousands separator)', () => {
    expect(minor('12.500')).toBe('PRICE_AMBIGUOUS_DECIMALS');
    expect(minor('12.345')).toBe('PRICE_AMBIGUOUS_DECIMALS');
    expect(minor('1.000')).toBe('PRICE_AMBIGUOUS_DECIMALS');
    expect(minor('١٢٫٥٠٠')).toBe('PRICE_AMBIGUOUS_DECIMALS');
  });

  it('rejects more than 2 significant decimals', () => {
    expect(minor('12.3456')).toBe('PRICE_TOO_MANY_DECIMALS');
  });

  it('rejects junk, malformed grouping, negatives and (when required) blanks', () => {
    expect(minor('abc')).toBe('PRICE_INVALID');
    expect(minor('4,85')).toBe('PRICE_INVALID');
    expect(minor('12,5')).toBe('PRICE_INVALID');
    expect(minor('EGP 250')).toBe('PRICE_INVALID');
    expect(minor('-5')).toBe('PRICE_NEGATIVE');
    expect(minor('99999999999')).toBe('PRICE_INVALID'); // beyond Postgres INT
    expect(minor('', true)).toBe('PRICE_REQUIRED');
    expect(minor('', false)).toBeNull();
  });

  it('names the code and the column in the message', () => {
    const r = parsePriceCell('12.500', { label: 'compareAtPrice' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/^PRICE_AMBIGUOUS_DECIMALS: compareAtPrice "12\.500"/);
  });
});

describe('platform CSV (merchant file in EGP -> internal piastres)', () => {
  it('converts all three price columns and keeps unknown columns', () => {
    const out = importCsvToPlatformCsv(
      'id,name,price,compareAtPrice,costPrice\nx1,Ring,"1,250.50",1500,٩٩٫٥'
    );
    expect(out.format).toBe('platform');
    expect(out.rowErrors).toEqual([]);
    const [h, r] = parseCsvRecords(out.csv);
    const row = Object.fromEntries(h.fields.map((k, i) => [k, r.fields[i]]));
    expect(row).toMatchObject({
      id: 'x1',
      price: '125050',
      compareAtPrice: '150000',
      costPrice: '9950',
      sourceRow: '2',
      _error: '',
    });
  });

  it('fails only the bad row, naming row and column; other rows import', () => {
    const out = importCsvToPlatformCsv('name,price\nOk,250\nBad,12.500\nJunk,abc\nNone,');
    expect(out.rowErrors.map(e => e.row)).toEqual([3, 4, 5]);
    expect(out.rowErrors[0].error).toMatch(/^PRICE_AMBIGUOUS_DECIMALS: price "12\.500"/);
    expect(out.rowErrors[1].error).toMatch(/^PRICE_INVALID/);
    expect(out.rowErrors[2].error).toMatch(/^PRICE_REQUIRED/);
    expect(out.csv).toContain('Ok,25000');
  });

  it('lets a variant row omit its price (inherits the parent) but not carry a bad one', () => {
    const out = importCsvToPlatformCsv(
      'name,price,sku,parentSku\nP,100,P1,\n,,V1,P1\n,1.234,V2,P1'
    );
    expect(out.rowErrors.map(e => e.row)).toEqual([4]);
  });
});

describe('XLSX -> internal CSV', () => {
  const sheet = async (rows: Array<Array<string | number>>) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('p');
    rows.forEach(r => ws.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
  };

  it('converts EGP cells (number and text) and flags 3-decimal cells on their sheet row', async () => {
    const csv = await xlsxBufferToImportCsv(
      await sheet([
        ['name', 'price'],
        ['A', 250.5],
        ['B', '١٢٫٥'],
        ['C', '12.500'],
      ])
    );
    // The XLSX converter's output is already the internal piastre CSV.
    expect(csv).toContain('25050');
    expect(csv).toContain('1250');
    const recs = parseCsvRecords(csv);
    const errCol = recs[0].fields.indexOf('_error');
    expect(recs[3].fields[errCol]).toMatch(/^PRICE_AMBIGUOUS_DECIMALS: price "12\.500"/);
    expect(recs[3].fields[recs[0].fields.indexOf('sourceRow')]).toBe('4');
  });

  it('maps the headers our own XLSX export writes ("Price (EGP)")', async () => {
    const csv = await xlsxBufferToImportCsv(
      await sheet([
        ['Name', 'Price (EGP)', 'Compare At Price (EGP)', 'Cost Price (EGP)'],
        ['A', 100, 150, 60],
      ])
    );
    expect(csv).toContain('10000');
    expect(csv).toContain('15000');
    expect(csv).toContain('6000');
  });
});

describe('dry-run preview', () => {
  const preview = (csv: string, store: number[] = []) =>
    buildImportPreview(importCsvToPlatformCsv(csv).csv, store);

  it('returns piastre prices, row errors with code+column, and counts', () => {
    const p = preview('name,price\nOk,250.50\nBad,12.500');
    expect(p.totalRows).toBe(2);
    expect(p.validRows).toBe(1);
    expect(p.invalidRows).toBe(1);
    expect(p.rows[0]).toMatchObject({ row: 2, name: 'Ok', price: 25050, error: null });
    expect(p.errors).toEqual([
      expect.objectContaining({ row: 3, column: 'price', code: 'PRICE_AMBIGUOUS_DECIMALS' }),
    ]);
  });

  it('warns when the file looks like old piastre prices against the store median', () => {
    const file = 'name,price\nA,5000\nB,7500\nC,12000';
    const w = preview(file, [5000, 7500, 6000]).warnings; // store sells at ~EGP 60; file says EGP 5,000+
    expect(w).toEqual([expect.objectContaining({ code: 'PRICES_LOOK_LIKE_PIASTRES' })]);
    expect(preview(file, []).warnings).toEqual([]); // no baseline, no guess
    expect(preview('name,price\nA,60\nB,75\nC,120', [5000, 7500, 6000]).warnings).toEqual([]);
  });
});

describe('template and export round trip', () => {
  it('the template parses with no row errors and EGP example prices', () => {
    const out = importCsvToPlatformCsv(BulkService.getImportTemplate());
    expect(out.rowErrors).toEqual([]);
    const [h, base, variant] = parseCsvRecords(out.csv);
    const col = (r: { fields: string[] }, k: string) => r.fields[h.fields.indexOf(k)];
    expect(col(base, 'price')).toBe('25050'); // template says 250.50
    expect(col(variant, 'price')).toBe('27500');
  });

  it('an exported file re-imports to the same piastres', async () => {
    const product = {
      id: 'p1',
      name: 'Ring',
      nameAr: null,
      slug: 'ring',
      description: null,
      descriptionAr: null,
      price: 125050,
      compareAtPrice: 150000,
      costPrice: 5,
      sku: 'R1',
      barcode: null,
      inventory: 3,
      lowStockThreshold: 5,
      trackInventory: true,
      weight: null,
      status: 'active',
      featured: false,
      isNew: false,
      metaTitle: null,
      metaTitleAr: null,
      metaDescription: null,
      metaDescriptionAr: null,
      images: [],
      categories: [],
      tags: [],
      variants: [
        {
          price: 99,
          compareAtPrice: null,
          costPrice: null,
          sku: 'R1-S',
          barcode: null,
          inventory: 1,
          weight: null,
          imageUrl: null,
          options: [],
        },
      ],
    };
    const spy = vi.spyOn(prisma.product, 'findMany').mockResolvedValue([product] as never);
    const csv = await BulkService.exportProducts('s1');
    spy.mockRestore();

    expect(csv).toContain('1250.50,1500.00,0.05'); // EGP decimals, never raw piastres
    const out = importCsvToPlatformCsv(csv);
    expect(out.rowErrors).toEqual([]);
    const [h, base, variant] = parseCsvRecords(out.csv);
    const col = (r: { fields: string[] }, k: string) => r.fields[h.fields.indexOf(k)];
    expect([col(base, 'price'), col(base, 'compareAtPrice'), col(base, 'costPrice')]).toEqual([
      '125050',
      '150000',
      '5',
    ]);
    expect(col(variant, 'price')).toBe('99');
  });
});
