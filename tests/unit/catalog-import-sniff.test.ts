import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFString } from '@cantoo/pdf-lib';
import {
  sniffCatalogueFile,
  normalizePdf,
  PdfRefused,
  displayFileName,
} from '../../apps/api/src/lib/catalogue/sniff';
import { chargeVerdict } from '../../apps/api/src/lib/catalogue/page-ledger';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

describe('sniffCatalogueFile: the bytes decide, never the name or mime', () => {
  it('accepts jpeg, png, webp, heic and pdf', () => {
    expect(sniffCatalogueFile(JPG)?.mime).toBe('image/jpeg');
    expect(sniffCatalogueFile(PNG)?.mime).toBe('image/png');
    expect(sniffCatalogueFile(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))?.mime).toBe('image/webp');
    expect(sniffCatalogueFile(Buffer.from('\0\0\0\x18ftypheic\0\0\0\0'))?.mime).toBe('image/heic');
    expect(sniffCatalogueFile(Buffer.from('%PDF-1.7\n'))).toEqual({
      kind: 'pdf',
      mime: 'application/pdf',
    });
  });
  it('refuses gif, text, executables, svg and a PDF header past byte 1024', () => {
    expect(sniffCatalogueFile(Buffer.from('GIF89a......'))).toBeNull();
    expect(sniffCatalogueFile(Buffer.from('hello world'))).toBeNull();
    expect(sniffCatalogueFile(Buffer.from('MZ\x90\0exe'))).toBeNull();
    expect(sniffCatalogueFile(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(
      sniffCatalogueFile(Buffer.concat([Buffer.alloc(2000), Buffer.from('%PDF-1.4')]))
    ).toBeNull();
  });
  it('a polyglot (image header, PDF text later) is an image', () => {
    expect(sniffCatalogueFile(Buffer.concat([PNG, Buffer.from('%PDF-1.4')]))?.kind).toBe('image');
  });
});

async function makePdf(pages: number, opts: { objectStreams: boolean; js?: boolean }) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage();
  if (opts.js) {
    doc.catalog.set(
      PDFName.of('OpenAction'),
      doc.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') })
    );
  }
  const bytes = Buffer.from(await doc.save({ useObjectStreams: opts.objectStreams }));
  // Hide the page type from a text scan while any real parser still reads it: "/Page" -> "/#50age"
  // (a PDF name escape). The page tree, which is what counts, is unchanged.
  return opts.objectStreams
    ? Buffer.from(bytes.toString('latin1').replaceAll('/Type /Page\n', '/Type /#50age\n'), 'latin1')
    : bytes;
}
const regexCount = (b: Buffer) =>
  b.toString('latin1').match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;

describe('normalizePdf: a real parse of the page tree', () => {
  it('counts pages the old text scan could not see (object streams hide /Type /Page)', async () => {
    const crafted = await makePdf(9, { objectStreams: true });
    expect(regexCount(crafted)).toBeLessThan(9); // the regex under-counts: the exploit
    const n = await normalizePdf(crafted, 10);
    expect(n.pages).toBe(9);
    // what is stored/sent has exactly the counted pages
    expect((await PDFDocument.load(n.bytes)).getPageCount()).toBe(9);
  });
  it('refuses over the cap, even when the text scan would see one page', async () => {
    const crafted = await makePdf(25, { objectStreams: true });
    expect(regexCount(crafted)).toBeLessThan(11);
    await expect(normalizePdf(crafted, 10)).rejects.toMatchObject({
      code: 'TOO_MANY_PAGES',
      pages: 25,
    });
  });
  it('refuses a PDF that cannot be parsed, and a header-only file', async () => {
    await expect(
      normalizePdf(Buffer.from('%PDF-1.4\n/Type /Page garbage'), 10)
    ).rejects.toBeInstanceOf(PdfRefused);
    await expect(normalizePdf(Buffer.from('%PDF-'), 10)).rejects.toMatchObject({
      code: 'UNREADABLE_PDF',
    });
  });
  it('drops scripts and open-actions on re-emit', async () => {
    const withJs = await makePdf(1, { objectStreams: false, js: true });
    expect(withJs.toString('latin1')).toContain('JavaScript');
    const n = await normalizePdf(withJs, 10);
    expect(n.bytes.toString('latin1')).not.toMatch(/JavaScript|OpenAction/);
  });
});

describe('display names', () => {
  it('display names carry no path or control characters', () => {
    expect(displayFileName('..\\..\\etc/pass‮wd.jpg')).toBe('passwd.jpg');
    expect(displayFileName('x'.repeat(500)).length).toBe(120);
  });
});

describe('page ledger verdict', () => {
  const a = {
    monthlyLimit: 100,
    usedMonth: 98,
    usedToday: 0,
    remainingMonth: 2,
    remainingToday: 60,
    enabled: true,
  };
  it('monthly and daily caps each refuse; unlimited plans only hit the daily cap', () => {
    expect(chargeVerdict(a, 2)).toBe('ok');
    expect(chargeVerdict(a, 3)).toBe('PLAN_PAGES_EXHAUSTED');
    expect(chargeVerdict({ ...a, remainingToday: 1 }, 2)).toBe('DAILY_PAGES_EXHAUSTED');
    expect(chargeVerdict({ ...a, monthlyLimit: null, remainingMonth: null }, 50)).toBe('ok');
  });
});
