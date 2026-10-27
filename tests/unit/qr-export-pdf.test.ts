import { describe, it, expect } from 'vitest';
import { deflateSync, inflateSync } from 'node:zlib';
import { buildPdf, fileStem } from '../../apps/admin/src/lib/qr-export';

describe('buildPdf', () => {
  const w = 40;
  const h = 50;
  const rgb = new Uint8Array(w * h * 3).fill(255);
  const pdf = buildPdf({
    widthPx: w,
    heightPx: h,
    deflatedRgb: new Uint8Array(deflateSync(rgb)),
    printWidthMm: 100,
    marginMm: 5,
    title: 'Ebda القهوة (x)',
  });
  const text = Buffer.from(pdf).toString('latin1');

  it('is a one-page PDF with the image at the requested physical size', () => {
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Count 1');
    // 100 mm = 283.46 pt; margin 5 mm = 14.17 pt; height keeps the 4:5 ratio -> 354.33 pt
    expect(text).toContain('q 283.46 0 0 354.33 14.17 14.17 cm /Im0 Do Q');
    expect(text).toContain('/MediaBox [0 0 311.81 382.68]');
  });

  it('xref offsets point at the objects and startxref at the table', () => {
    const start = Number(/startxref\n(\d+)\n/.exec(text)![1]);
    expect(text.slice(start, start + 4)).toBe('xref');
    const entries = [...text.slice(start).matchAll(/(\d{10}) 00000 n /g)].map(m => Number(m[1]));
    expect(entries).toHaveLength(6);
    entries.forEach((o, i) => expect(text.slice(o, o + 7)).toBe(`${i + 1} 0 obj`));
  });

  it('embeds the deflated pixels untouched, and strips unsafe characters from the title', () => {
    const i = text.indexOf('stream\n', text.indexOf('/Subtype /Image')) + 7;
    const len = Number(
      /\/Length (\d+) >>\nstream/.exec(text.slice(text.indexOf('/Subtype /Image')))![1]
    );
    const inflated = inflateSync(Buffer.from(pdf.slice(i, i + len)));
    expect(inflated.length).toBe(w * h * 3);
    expect(text).toContain('/Title (Ebda  x)');
  });
});

describe('fileStem', () => {
  it('is ascii-safe', () => {
    expect(fileStem('Demo Shop!')).toBe('qr-demo-shop');
    expect(fileStem('متجري')).toBe('qr-code');
  });
});
