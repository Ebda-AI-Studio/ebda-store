import { describe, it, expect } from 'vitest';
import {
  sniffCatalogueFile,
  countPdfPages,
  pdfHasActiveContent,
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

describe('pdf helpers', () => {
  it('counts /Type /Page objects but not /Pages, at least 1', () => {
    expect(countPdfPages(Buffer.from('<</Type/Pages>><</Type /Page>><</Type/Page>>'))).toBe(2);
    expect(countPdfPages(Buffer.from('%PDF-'))).toBe(1);
  });
  it('flags active content without refusing', () => {
    expect(pdfHasActiveContent(Buffer.from('%PDF-1.4 /OpenAction'))).toBe(true);
    expect(pdfHasActiveContent(Buffer.from('%PDF-1.4 plain'))).toBe(false);
  });
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
