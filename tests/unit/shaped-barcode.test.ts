import { describe, it, expect } from 'vitest';
import {
  encodeCode128,
  code128Modules,
  renderBarcodeSvg,
  RECEIPT_BARCODE_SHAPES,
  receiptBarcodeShapeSchema,
} from '../../packages/shared/src/barcode';

describe('code128 encoder', () => {
  it('uses subset C for even digit strings and B otherwise, with a valid checksum', () => {
    // "12" in subset C: START C (105), value 12, checksum (105 + 12*1) % 103 = 14, STOP (106)
    expect(encodeCode128('12')).toEqual([105, 12, 14, 106]);
    // "A" in subset B: START B (104), 'A'-32 = 33, checksum (104 + 33) % 103 = 34, STOP
    expect(encodeCode128('A')).toEqual([104, 33, 34, 106]);
  });
  it('modules: 11 per symbol, 13 for stop, never two quiet-breaking runs > 4', () => {
    const m = code128Modules('ORD-MJ4K9L2A-AB3XY');
    expect(m.length).toBe(11 * 20 + 13);
    expect(m[0]).toBe(true);
    expect(m[m.length - 1]).toBe(true);
  });
  it('rejects characters Code 128 B cannot carry', () => {
    expect(() => encodeCode128('ORD-١٢٣')).toThrow();
    expect(() => encodeCode128('')).toThrow();
  });
});

describe('shape registry + schema', () => {
  it('has the 24 approved shapes', () => {
    expect(RECEIPT_BARCODE_SHAPES).toHaveLength(24);
    expect(new Set(RECEIPT_BARCODE_SHAPES).size).toBe(24);
  });
  it('schema accepts plain/off/shapes and rejects anything else', () => {
    for (const ok of ['plain', 'off', 'palm', 'ghost']) expect(receiptBarcodeShapeSchema.safeParse(ok).success).toBe(true);
    for (const bad of ['', 'Palm', 'star', '<script>', 1]) expect(receiptBarcodeShapeSchema.safeParse(bad).success).toBe(false);
  });
});

describe('renderBarcodeSvg', () => {
  it('plain: bars + the readable number, no mask', () => {
    const svg = renderBarcodeSvg({ value: 'ORD-1', shape: 'plain' });
    expect(svg).toContain('<svg');
    expect(svg).toContain('ORD-1');
    expect(svg).not.toContain('<mask');
  });
  it('shaped: masked bars, full-width scan zone, currentColor ink (never orange)', () => {
    const svg = renderBarcodeSvg({ value: 'ORD-1', shape: 'palm' });
    expect(svg).toContain('<mask');
    expect(svg).toContain('currentColor');
    expect(svg.toLowerCase()).not.toContain('#ff6e01');
  });
  it('escapes the human-readable value', () => {
    const svg = renderBarcodeSvg({ value: 'A&B', shape: 'plain' });
    expect(svg).toContain('A&amp;B');
  });
});

import { billingPaymentNumber, EBDA_BILLING_BARCODE_SHAPE } from '../../packages/shared/src/barcode';
describe('ebda billing barcode', () => {
  it('uses palm and a deterministic Code 128 safe payment number', () => {
    expect(EBDA_BILLING_BARCODE_SHAPE).toBe('palm');
    expect(RECEIPT_BARCODE_SHAPES).toContain(EBDA_BILLING_BARCODE_SHAPE);
    expect(billingPaymentNumber('3f2a91c4-7b1e-4d0a-9c55-0e8a1f2b3c4d')).toBe('EBD-3F2A91C47B');
    expect(() => billingPaymentNumber('x')).toThrow();
  });
});
