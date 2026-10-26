import { describe, it, expect } from 'vitest';
import {
  ean13CheckDigit,
  ean13Modules,
  isInStoreEan13,
  isValidEan13,
  isValidUpcA,
  makeInStoreEan13,
  parseBarcodeInput,
} from '../../packages/shared/src/barcode';

describe('EAN-13 / UPC-A', () => {
  it('check digits match known retail codes', () => {
    expect(ean13CheckDigit('400638133393')).toBe(1);
    expect(ean13CheckDigit('590123412345')).toBe(7);
    expect(isValidEan13('4006381333931')).toBe(true);
    expect(isValidEan13('4006381333932')).toBe(false);
    expect(isValidUpcA('036000291452')).toBe(true);
    expect(isValidUpcA('036000291453')).toBe(false);
  });
  it('in-store codes use prefixes 20-29 and always validate', () => {
    for (const p of [20, 24, 29]) {
      const c = makeInStoreEan13(p, 123456);
      expect(c).toHaveLength(13);
      expect(c.startsWith(String(p))).toBe(true);
      expect(isInStoreEan13(c)).toBe(true);
    }
    expect(() => makeInStoreEan13(19, 1)).toThrow();
    expect(() => makeInStoreEan13(30, 1)).toThrow();
    expect(() => makeInStoreEan13(20, 10_000_000_000)).toThrow();
    expect(isInStoreEan13('4006381333931')).toBe(false);
  });
  it('encodes 95 modules with guards', () => {
    const m = ean13Modules('4006381333931');
    expect(m).toHaveLength(95);
    expect(m.slice(0, 3)).toEqual([true, false, true]);
    expect(m.slice(92)).toEqual([true, false, true]);
    expect(() => ean13Modules('4006381333932')).toThrow();
  });
});

describe('parseBarcodeInput', () => {
  it('accepts EAN-13, UPC-A and Code 128 text', () => {
    expect(parseBarcodeInput('4006381333931')).toEqual({
      ok: true,
      kind: 'ean13',
      value: '4006381333931',
    });
    expect(parseBarcodeInput('036000291452')).toEqual({
      ok: true,
      kind: 'upca',
      value: '036000291452',
    });
    expect(parseBarcodeInput(' SKU-12/AB ')).toEqual({
      ok: true,
      kind: 'code128',
      value: 'SKU-12/AB',
    });
    expect(parseBarcodeInput('12345')).toEqual({ ok: true, kind: 'code128', value: '12345' });
  });
  it('folds Arabic-Indic and Persian digits', () => {
    expect(parseBarcodeInput('٤٠٠٦٣٨١٣٣٣٩٣١')).toMatchObject({
      ok: true,
      kind: 'ean13',
      value: '4006381333931',
    });
    expect(parseBarcodeInput('۴۰۰۶۳۸۱۳۳۳۹۳۱')).toMatchObject({ ok: true, kind: 'ean13' });
  });
  it('rejects a wrong check digit, empty, non-ASCII text and over-long text', () => {
    expect(parseBarcodeInput('4006381333932')).toEqual({ ok: false, reason: 'check-digit' });
    expect(parseBarcodeInput('036000291453')).toEqual({ ok: false, reason: 'check-digit' });
    expect(parseBarcodeInput('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(parseBarcodeInput('خاتم')).toEqual({ ok: false, reason: 'charset' });
    expect(parseBarcodeInput('x'.repeat(49))).toEqual({ ok: false, reason: 'length' });
    expect(parseBarcodeInput('a\tb')).toEqual({ ok: false, reason: 'charset' });
  });
});
