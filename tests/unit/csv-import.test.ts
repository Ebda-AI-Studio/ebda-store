/**
 * Unit tests: CSV -> platform-CSV mapping (Shopify grouping, variants,
 * compare-at, strict EGP decimals, Arabic, BOM). Pure — no DB, no network.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  importCsvToPlatformCsv,
  parseCsvRecords,
  decodeCsvBytes,
  PLATFORM_COLUMNS,
} from '../../apps/api/src/services/csv-import';

const HEADER =
  'Handle,Title,Body (HTML),Tags,Published,Option1 Name,Option1 Value,Variant SKU,Variant Grams,Variant Inventory Tracker,Variant Inventory Qty,Variant Price,Variant Compare At Price,Image Src,Image Position,Variant Image,Status';

const convert = (...lines: string[]) => importCsvToPlatformCsv([HEADER, ...lines].join('\n'));

describe('importCsvToPlatformCsv — layout detection', () => {
  it("passes FWB's own template through untouched (piastres), BOM stripped", () => {
    const csv = '﻿name,price,sku\nRing,485000,R1';
    const out = importCsvToPlatformCsv(csv);
    expect(out.format).toBe('platform');
    expect(out.csv).toBe('name,price,sku\nRing,485000,R1');
  });

  it('detects the Shopify layout from Handle + Title', () => {
    expect(convert('r1,Ring,,,TRUE,,,,,,,10.00,,,,,').format).toBe('shopify');
  });

  it('rejects a Shopify file with no Variant Price column', () => {
    expect(() => importCsvToPlatformCsv('Handle,Title\nr1,Ring')).toThrow(/Variant Price/);
  });
});

describe('Shopify grouping', () => {
  it('maps a single-variant product to a flat product with piastre prices', () => {
    const { rows } = convert(
      'hoop,Hoop Earrings,<p>x</p>,"earrings, gold",TRUE,Title,Default Title,SKU1,3,shopify,8,4850.00,5500.00,https://img.test/a.jpg,1,,active'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'Hoop Earrings',
      slug: 'hoop',
      price: '485000',
      compareAtPrice: '550000',
      sku: 'SKU1',
      inventory: '8',
      trackInventory: 'true',
      weight: '0.003',
      status: 'active',
      tags: 'earrings,gold',
      images: 'https://img.test/a.jpg',
      parentSku: '',
    });
  });

  it('groups variant rows by Handle: parent (lowest price, zero stock) + one row per variant', () => {
    const { rows } = convert(
      'ring,Solitaire Ring,,rings,TRUE,Size,6,R-6,3,shopify,5,18750.00,,https://img.test/1.jpg,1,,active',
      'ring,,,,,,7,R-7,4,shopify,6,18850.00,19900.00,https://img.test/2.jpg,2,,',
      'ring,,,,,,8,R-8,5,shopify,7,18950.00,,,,https://img.test/v8.jpg,'
    );
    expect(rows).toHaveLength(4);
    const [parent, v6, v7, v8] = rows;
    expect(parent).toMatchObject({
      name: 'Solitaire Ring',
      sku: 'ring',
      price: '1875000',
      inventory: '0',
      images: 'https://img.test/1.jpg,https://img.test/2.jpg',
      parentSku: '',
    });
    expect(v6).toMatchObject({
      parentSku: 'ring',
      sku: 'R-6',
      price: '1875000',
      option1Name: 'Size',
      option1Value: '6',
      inventory: '5',
    });
    // compare-at only kept when it is actually above the price
    expect(v7).toMatchObject({ option1Value: '7', compareAtPrice: '1990000' });
    expect(v6.compareAtPrice).toBe('');
    // Variant Image rides on the variant, not the product gallery
    expect(v8.images).toBe('https://img.test/v8.jpg');
    expect(parent.images).not.toContain('v8.jpg');
  });

  it('takes image-only rows into the gallery, ordered by Image Position', () => {
    const { rows } = convert(
      'p,P,,,TRUE,Title,Default Title,S1,,shopify,1,10.00,,https://img.test/b.jpg,2,,active',
      'p,,,,,,,,,,,,,https://img.test/a.jpg,1,,'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].images).toBe('https://img.test/a.jpg,https://img.test/b.jpg');
  });

  it('maps Published=FALSE to draft and keeps explicit statuses', () => {
    const draft = convert('d,D,,,FALSE,Title,Default Title,S,,shopify,1,10.00,,,,,active').rows[0];
    expect(draft.status).toBe('draft');
    const archived = convert('a,A,,,TRUE,Title,Default Title,S,,shopify,1,10.00,,,,,archived')
      .rows[0];
    expect(archived.status).toBe('archived');
  });

  it('clamps negative stock to 0 and ignores a compare-at not above the price', () => {
    const r = convert('n,N,,,TRUE,Title,Default Title,S,,shopify,-3,10.00,10.00,,,,active').rows[0];
    expect(r.inventory).toBe('0');
    expect(r.compareAtPrice).toBe('');
  });

  it('percent-encodes commas inside image URLs (the importer splits on commas)', () => {
    const r = convert(
      'c,C,,,TRUE,Title,Default Title,S,,shopify,1,10.00,,"https://img.test/a,b.jpg",1,,active'
    ).rows[0];
    expect(r.images).toBe('https://img.test/a%2Cb.jpg');
  });
});

describe('strict EGP money (tryToMinor)', () => {
  it('REJECTS a 3-decimal price on that row only, never rounding it', () => {
    const out = convert(
      'bad,Bad,,,TRUE,Title,Default Title,S1,,shopify,1,12.505,,,,,active',
      'ok,Ok,,,TRUE,Title,Default Title,S2,,shopify,1,12.50,,,,,active'
    );
    expect(out.rowErrors).toHaveLength(1);
    expect(out.rowErrors[0].row).toBe(2);
    expect(out.rowErrors[0].error).toMatch(/12\.505.*2 decimals/);
    const ok = out.rows.find(r => r.slug === 'ok')!;
    expect(ok.price).toBe('1250');
    expect(out.csv).not.toMatch(/1251|1250,.*bad/);
  });

  it('rejects a bad variant price but still imports the product with its other variants', () => {
    const out = convert(
      'v,V,,,TRUE,Size,S,V-S,,shopify,1,10.00,,,,,active',
      'v,,,,,,M,V-M,,shopify,1,11.999,,,,,',
      'v,,,,,,L,V-L,,shopify,1,12.00,,,,,'
    );
    expect(out.rowErrors).toEqual([expect.objectContaining({ row: 3 })]);
    expect(out.rows.filter(r => r.parentSku === 'v').map(r => r.option1Value)).toEqual(['S', 'L']);
  });

  it('accepts well-formed thousands grouping and rejects malformed grouping', () => {
    expect(
      convert('g,G,,,TRUE,Title,Default Title,S,,shopify,1,"4,850.00",,,,,active').rows[0].price
    ).toBe('485000');
    const bad = convert('h,H,,,TRUE,Title,Default Title,S,,shopify,1,"4,85",,,,,active');
    expect(bad.rowErrors).toHaveLength(1);
  });

  it('rejects missing and negative prices', () => {
    const out = convert(
      'm,M,,,TRUE,Title,Default Title,S1,,shopify,1,,,,,,active',
      'n,N,,,TRUE,Title,Default Title,S2,,shopify,1,-5.00,,,,,active'
    );
    expect(out.rowErrors.map(e => e.row)).toEqual([2, 3]);
  });

  it('reports a row with no Handle and a product with no Title, per row', () => {
    const out = convert(
      ',Orphan,,,TRUE,Title,Default Title,S1,,shopify,1,10.00,,,,,active',
      't,,,,TRUE,Title,Default Title,S2,,shopify,1,10.00,,,,,active'
    );
    expect(out.rowErrors).toHaveLength(2);
    const msgs = out.rowErrors.map(e => e.error).join('|');
    expect(msgs).toMatch(/Handle is required/);
    expect(msgs).toMatch(/Title is required/);
  });

  it('numbers errors by the row in the uploaded file (header = 1), across multi-line cells', () => {
    const out = convert(
      'a,A,"<p>line1\nline2</p>",,TRUE,Title,Default Title,S1,,shopify,1,10.00,,,,,active',
      'b,B,,,TRUE,Title,Default Title,S2,,shopify,1,1.234,,,,,active'
    );
    expect(out.rowErrors).toEqual([expect.objectContaining({ row: 3 })]);
  });
});

describe('Arabic text and BOM', () => {
  const AR = 'خاتم سوليتير ذهب عيار 18';

  it('keeps Arabic titles/descriptions byte-for-byte and fills nameAr', () => {
    const csv =
      'Handle,Title,Title (AR),Body (HTML) (AR),Variant Price,Variant SKU\n' +
      `r,Solitaire Ring,${AR},<p>${AR}</p>,100.00,S1`;
    const r = importCsvToPlatformCsv(csv).rows[0];
    expect(r.name).toBe('Solitaire Ring');
    expect(r.nameAr).toBe(AR);
    expect(r.descriptionAr).toBe(`<p>${AR}</p>`);
  });

  it('treats an Arabic-only Title as both name and nameAr (name is required)', () => {
    const r = importCsvToPlatformCsv(`Handle,Title,Variant Price\nr,${AR},100.00`).rows[0];
    expect(r.name).toBe(AR);
    expect(r.nameAr).toBe(AR);
  });

  it('survives a UTF-8 BOM before the first header', () => {
    const csv = `﻿Handle,Title,Variant Price\nr,${AR},100.00`;
    const out = importCsvToPlatformCsv(csv);
    expect(out.format).toBe('shopify');
    expect(out.rows[0].name).toBe(AR);
    expect(out.csv.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('decodes uploaded bytes with and without BOM, and UTF-16LE', () => {
    const text = `Handle,Title\nr,${AR}`;
    const utf8 = Buffer.from(text, 'utf8');
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]);
    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    for (const b of [utf8, bom, u16]) expect(decodeCsvBytes(b)).toBe(text);
  });
});

describe('RFC 4180 parsing', () => {
  it('handles CRLF, quoted commas, doubled quotes and skips blank lines', () => {
    const recs = parseCsvRecords('a,b\r\n"x, y","he said ""hi"""\r\n\r\n,\r\nlast,1');
    expect(recs.map(r => r.fields)).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
      ['last', '1'],
    ]);
    expect(recs.map(r => r.number)).toEqual([1, 2, 3]);
  });
});

describe('Amelia Aurum synthetic fixture', () => {
  const text = readFileSync(resolve(__dirname, '../fixtures/amelia-aurum-catalogue.csv'), 'utf8');

  it('converts with zero row errors into 13 products and 20 variants from 29 source rows', () => {
    const out = importCsvToPlatformCsv(text);
    expect(out.rowErrors).toEqual([]);
    const parents = out.rows.filter(r => !r.parentSku);
    const variants = out.rows.filter(r => r.parentSku);
    expect(parents).toHaveLength(13);
    expect(variants).toHaveLength(20); // rings 4+3+3, necklaces 2+3+2, bracelet 3
    expect(out.csv.split('\n')[0]).toBe(PLATFORM_COLUMNS.join(','));
    expect(parents.every(p => p.nameAr && /[؀-ۿ]/.test(p.nameAr))).toBe(true);
  });
});

describe('bulk-import Inngest function scope', () => {
  it('runs importProducts in a store scope, not one outer tenant transaction', () => {
    // Under runInTenantContext the categories/tags created up front are
    // uncommitted when importProducts' own withMoneyTx batches try to link
    // them -> FK violation on every import that introduces a new category.
    const src = readFileSync(
      resolve(__dirname, '../../apps/api/src/lib/inngest/functions/bulk-import.ts'),
      'utf8'
    );
    expect(src).toMatch(/await runInStoreScope\(job\.storeId/);
    expect(src).not.toMatch(/await runInTenantContext\(/);
  });
});
