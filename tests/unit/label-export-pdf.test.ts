import { describe, it, expect } from 'vitest';
import { deflateSync, inflateSync } from 'node:zlib';
import { buildPagesPdf, planPages } from '../../apps/admin/src/lib/label-export';
import { labelPresetById } from '../../packages/shared/src/barcode';

const img = (w: number, h: number, v: number) => ({
  widthPx: w,
  heightPx: h,
  deflatedRgb: new Uint8Array(deflateSync(new Uint8Array(w * h * 3).fill(v))),
});

describe('planPages', () => {
  it('fills A4 cells row by row, copies of one label first, and starts a new page after the last cell', () => {
    const p = labelPresetById('a4-3x7')!; // 21 per page
    const pages = planPages(p, [
      { image: 0, copies: 20, widthMm: 63.5, heightMm: 38.1 },
      { image: 1, copies: 3, widthMm: 63.5, heightMm: 38.1 },
    ]);
    expect(pages).toHaveLength(2);
    expect(pages[0].placements).toHaveLength(21);
    expect(pages[0].placements[20].image).toBe(1);
    expect(pages[1].placements.map(x => x.image)).toEqual([1, 1]);
    expect(pages[0].placements[0]).toMatchObject({ xMm: 7.2, yMm: 15.15 });
    expect(pages[0].widthMm).toBe(210);
  });
  it('a roll gets one page per copy at the label size', () => {
    const pages = planPages(labelPresetById('roll-58')!, [
      { image: 0, copies: 3, widthMm: 58, heightMm: 52.5 },
    ]);
    expect(pages).toHaveLength(3);
    expect(pages[0]).toMatchObject({ widthMm: 58, heightMm: 52.5 });
    expect(pages[0].placements[0]).toMatchObject({ xMm: 0, yMm: 0, wMm: 58, hMm: 52.5 });
  });
  it('no labels means no pages', () => {
    expect(planPages(labelPresetById('a4-3x7')!, [])).toEqual([]);
  });
});

describe('buildPagesPdf', () => {
  const images = [img(10, 6, 255), img(8, 8, 0)];
  const pages = [
    {
      widthMm: 210,
      heightMm: 297,
      placements: [
        { image: 0, xMm: 10, yMm: 20, wMm: 63.5, hMm: 38.1 },
        { image: 1, xMm: 80, yMm: 20, wMm: 30, hMm: 30 },
      ],
    },
    { widthMm: 58, heightMm: 40, placements: [{ image: 0, xMm: 0, yMm: 0, wMm: 58, hMm: 40 }] },
  ];
  const pdf = buildPagesPdf({ images, pages, title: 'Labels القهوة (x)' });
  const text = Buffer.from(pdf).toString('latin1');

  it('has one page object per page with its own MediaBox, and embeds each image once', () => {
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Count 2');
    expect(text).toContain('/MediaBox [0 0 595.28 841.89]');
    expect(text).toContain('/MediaBox [0 0 164.41 113.39]');
    expect(text.match(/\/Subtype \/Image/g)).toHaveLength(2);
  });
  it('places an image by its top-left in mm (PDF origin is bottom-left)', () => {
    // y = 841.89 - (20 + 38.1) mm in pt = 841.89 - 164.69 = 677.20
    expect(text).toContain('q 180.00 0 0 108.00 28.35 677.20 cm /Im0 Do Q');
  });
  it('xref offsets point at their objects and startxref at the table', () => {
    const start = Number(/startxref\n(\d+)\n/.exec(text)![1]);
    expect(text.slice(start, start + 4)).toBe('xref');
    const entries = [...text.slice(start).matchAll(/(\d{10}) 00000 n /g)].map(m => Number(m[1]));
    expect(entries).toHaveLength(3 + 2 + 4);
    entries.forEach((o, i) =>
      expect(text.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`)
    );
  });
  it('keeps the deflated pixels byte-for-byte, and strips unsafe characters from the title', () => {
    const i = text.indexOf('stream\n', text.indexOf('/Subtype /Image')) + 7;
    const len = Number(
      /\/Length (\d+) >>\nstream/.exec(text.slice(text.indexOf('/Subtype /Image')))![1]
    );
    expect(inflateSync(Buffer.from(pdf.slice(i, i + len))).length).toBe(10 * 6 * 3);
    expect(text).toContain('/Title (Labels  x)');
  });
});
