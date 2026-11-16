import { describe, it, expect } from 'vitest';
import {
  A4_MM,
  DEFAULT_LABEL_SETTINGS,
  LABEL_PRESETS,
  MIN_MODULE_MM,
  humanDigits,
  labelPresetById,
  labelSettingsSchema,
  layoutLabel,
  sheetCell,
  type LabelItem,
  type LabelSettings,
} from '../../packages/shared/src/barcode';

const ITEM: LabelItem = {
  name: 'Gold ring',
  nameAr: 'خاتم ذهب',
  variantTitle: 'Size 7',
  variantTitleAr: 'مقاس ٧',
  priceMinor: 125000,
  barcode: '2000000000015',
};
const ALL: LabelSettings = {
  ...DEFAULT_LABEL_SETTINGS,
  content: { name: true, variant: true, price: true, digits: true, qr: true },
};

describe('label presets', () => {
  it('every A4 sheet fits the page, including its last row and column', () => {
    for (const p of LABEL_PRESETS.filter(x => x.kind === 'sheet')) {
      const last = sheetCell(p, p.cols! * p.rows! - 1);
      expect(last.x + p.widthMm, p.id).toBeLessThanOrEqual(A4_MM.w);
      expect(last.y + p.heightMm, p.id).toBeLessThanOrEqual(A4_MM.h);
      expect(sheetCell(p, 0)).toEqual({ page: 0, x: p.marginLeftMm, y: p.marginTopMm });
      expect(sheetCell(p, p.cols! * p.rows!).page).toBe(1);
    }
    expect(LABEL_PRESETS.map(p => p.id)).toEqual(
      expect.arrayContaining([
        'a4-3x7',
        'a4-4x10',
        'a4-5x13',
        'roll-58',
        'roll-80',
        'roll-40x30',
        'roll-50x25',
      ])
    );
  });
  it('sheet cells are row-major', () => {
    const p = labelPresetById('a4-3x7')!;
    expect(sheetCell(p, 1).x).toBeCloseTo(p.marginLeftMm! + p.widthMm + p.gapXMm!);
    expect(sheetCell(p, 3).y).toBeCloseTo(p.marginTopMm! + p.heightMm);
    expect(() => sheetCell(labelPresetById('roll-58')!, 0)).toThrow();
  });
});

describe('layoutLabel', () => {
  for (const preset of LABEL_PRESETS)
    for (const lang of ['ar', 'en'] as const)
      it(`${preset.id} ${lang}: everything stays inside the label and never overlaps`, () => {
        const l = layoutLabel(preset, ITEM, { ...ALL, lang });
        const boxes = [
          ...l.texts.map(t => ({ n: t.role, x: t.x, y: t.y, w: t.w, h: t.h })),
          { n: 'barcode', x: l.barcode.x, y: l.barcode.y, w: l.barcode.w, h: l.barcode.h },
          ...(l.qr ? [{ n: 'qr', x: l.qr.x, y: l.qr.y, w: l.qr.size, h: l.qr.size }] : []),
        ];
        for (const b of boxes) {
          expect(b.x, `${b.n} left`).toBeGreaterThanOrEqual(0);
          expect(b.y, `${b.n} top`).toBeGreaterThanOrEqual(0);
          expect(b.x + b.w, `${b.n} right`).toBeLessThanOrEqual(preset.widthMm + 1e-6);
          expect(b.y + b.h, `${b.n} bottom`).toBeLessThanOrEqual(l.heightMm + 1e-6);
        }
        for (let i = 0; i < boxes.length; i++)
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i];
            const c = boxes[j];
            const overlap =
              a.x < c.x + c.w - 1e-6 &&
              c.x < a.x + a.w - 1e-6 &&
              a.y < c.y + c.h - 1e-6 &&
              c.y < a.y + a.h - 1e-6;
            expect(overlap, `${a.n} overlaps ${c.n} on ${preset.id}`).toBe(false);
          }
      });

  it('uses the language of the label for name, variant and price', () => {
    const ar = layoutLabel(labelPresetById('a4-3x7')!, ITEM, { ...ALL, lang: 'ar' });
    expect(ar.texts.find(t => t.role === 'name')!.text).toBe('خاتم ذهب');
    expect(ar.texts.find(t => t.role === 'price')!.text).toBe('1250\u00a0ج.م');
    expect(ar.texts.find(t => t.role === 'name')!.rtl).toBe(true);
    const en = layoutLabel(labelPresetById('a4-3x7')!, ITEM, { ...ALL, lang: 'en' });
    expect(en.texts.find(t => t.role === 'price')!.text).toBe('EGP\u00a01250');
    expect(en.texts.find(t => t.role === 'digits')!.text).toBe('2 000000 000015');
    // Arabic name missing -> falls back to the English one
    const fb = layoutLabel(
      labelPresetById('a4-3x7')!,
      { ...ITEM, nameAr: null },
      { ...ALL, lang: 'ar' }
    );
    expect(fb.texts.find(t => t.role === 'name')!.text).toBe('Gold ring');
  });

  it('drops what does not fit, in a fixed order, and says so; the barcode is never dropped', () => {
    const tiny = layoutLabel(labelPresetById('a4-5x13')!, ITEM, ALL);
    expect(tiny.dropped).toContain('qr');
    expect(tiny.barcode.h).toBeGreaterThanOrEqual(5);
    const big = layoutLabel(labelPresetById('a4-3x7')!, ITEM, ALL);
    expect(big.dropped).toEqual([]);
    expect(big.qr).not.toBeNull();
  });

  it('plain EAN-13 prints on every preset; a shaped Code 128 of 13 digits is refused on the small ones', () => {
    for (const p of LABEL_PRESETS) {
      const l = layoutLabel(p, ITEM, { ...ALL, shape: 'plain' });
      expect(l.barcode.symbology).toBe('ean13');
      expect(l.barcode.moduleMm, p.id).toBeGreaterThanOrEqual(MIN_MODULE_MM);
      expect(l.printable, p.id).toBe(true);
    }
    const shaped = layoutLabel(labelPresetById('roll-40x30')!, ITEM, { ...ALL, shape: 'palm' });
    expect(shaped.barcode.symbology).toBe('code128');
    expect(shaped.printable).toBe(false);
    expect(
      layoutLabel(labelPresetById('roll-80')!, ITEM, { ...ALL, shape: 'palm' }).printable
    ).toBe(true);
  });

  it('a shape grows a continuous roll to fit it and stays inside the label; fixed labels scale it down', () => {
    for (const id of ['roll-58', 'roll-80']) {
      const p = labelPresetById(id)!;
      const l = layoutLabel(p, ITEM, {
        ...ALL,
        shape: 'palm',
        content: { ...ALL.content, qr: false },
      });
      expect(l.heightMm, id).toBeGreaterThan(p.heightMm);
      expect(l.barcode.art.y + l.barcode.art.h, id).toBeLessThanOrEqual(l.heightMm);
      expect(l.barcode.art.w, id).toBeCloseTo(l.barcode.w, 5);
    }
    expect(
      layoutLabel(labelPresetById('roll-80')!, ITEM, { ...ALL, shape: 'palm' }).printable
    ).toBe(true);
    const fixed = layoutLabel(labelPresetById('a4-3x7')!, ITEM, { ...ALL, shape: 'palm' });
    expect(fixed.heightMm).toBe(38.1);
    expect(fixed.barcode.art.w).toBeLessThan(fixed.barcode.w);
    expect(fixed.printable).toBe(false);
  });

  it('a Code 128 (non-EAN) code prints as Code 128 even when plain', () => {
    const l = layoutLabel(labelPresetById('a4-3x7')!, { ...ITEM, barcode: 'SKU-77' }, ALL);
    expect(l.barcode.symbology).toBe('code128');
  });
});

describe('humanDigits + settings schema', () => {
  it('groups EAN-13 and UPC-A as printed', () => {
    expect(humanDigits('4006381333931')).toBe('4 006381 333931');
    expect(humanDigits('036000291452')).toBe('0 36000 29145 2');
    expect(humanDigits('SKU-1')).toBe('SKU-1');
  });
  it('validates stored label settings (strict)', () => {
    expect(labelSettingsSchema.safeParse(DEFAULT_LABEL_SETTINGS).success).toBe(true);
    expect(
      labelSettingsSchema.safeParse({ ...DEFAULT_LABEL_SETTINGS, shape: 'nope' }).success
    ).toBe(false);
    expect(labelSettingsSchema.safeParse({ ...DEFAULT_LABEL_SETTINGS, preset: 'a3' }).success).toBe(
      false
    );
    expect(
      labelSettingsSchema.safeParse({ ...DEFAULT_LABEL_SETTINGS, shape: 'palm' }).success
    ).toBe(true);
    expect(labelSettingsSchema.safeParse({ ...DEFAULT_LABEL_SETTINGS, extra: 1 }).success).toBe(
      false
    );
  });
});
