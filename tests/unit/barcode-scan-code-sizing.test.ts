import { describe, it, expect } from 'vitest';
import {
  scanCodeFor,
  orderNumberFromScanCode,
  code128Modules,
  BARCODE_DISPLAY_PX,
  MIN_MODULE_CSS_PX,
  moduleCssPx,
  resolveBarcodeShape,
  RECEIPT_BARCODE_SHAPES,
} from '../../packages/shared/src/barcode';

describe('scan code (compact, reversible)', () => {
  it('turns the standard order number into 18 digits (Code 128 C) and back', () => {
    const n = 'ORD-T5JK9Q-AB3XY';
    const code = scanCodeFor(n);
    expect(code).toMatch(/^\d{18}$/);
    expect(orderNumberFromScanCode(code)).toBe(n);
    // base36 edge values
    for (const x of ['ORD-000000-00000', 'ORD-ZZZZZZ-ZZZZZ', 'ORD-100000-0000Z']) {
      expect(orderNumberFromScanCode(scanCodeFor(x))).toBe(x);
    }
  });
  it('is shorter than the raw number: 134 modules (+20 quiet) vs 211', () => {
    expect(code128Modules(scanCodeFor('ORD-T5JK9Q-AB3XY')).length).toBe(134); // +20 quiet = 154
    expect(code128Modules('ORD-T5JK9Q-AB3XY').length).toBe(211);
  });
  it('EBD- payment numbers carry their 16 digits; other formats pass through', () => {
    expect(scanCodeFor('EBD-1234567890123456')).toBe('1234567890123456');
    expect(orderNumberFromScanCode('1234567890123456')).toBe('EBD-1234567890123456');
    expect(scanCodeFor('1043')).toBe('1043');
    expect(scanCodeFor('N-1')).toBe('N-1');
    expect(orderNumberFromScanCode('1043')).toBe('1043');
  });
});

describe('minimum module width rule', () => {
  it('defines the display sizes and a 2 css px floor', () => {
    expect(MIN_MODULE_CSS_PX).toBe(2);
    expect(Object.keys(BARCODE_DISPLAY_PX).sort()).toEqual(['billingReceipt', 'email', 'invoice', 'storefrontReceipt']);
  });
  it('plain spans the width; a shape loses the padding share', () => {
    const v = 'ORD-T5JK9Q-AB3XY';
    expect(moduleCssPx(v, 'plain', 308)).toBeCloseTo(2, 1); // 308 / 154
    expect(moduleCssPx(v, 'palm', 308)).toBeLessThan(moduleCssPx(v, 'plain', 308));
  });
  it('falls back to plain when the shape cannot meet the floor, keeps it when it can', () => {
    const v = 'ORD-T5JK9Q-AB3XY';
    expect(resolveBarcodeShape('palm', v, 400)).toBe('palm');
    expect(resolveBarcodeShape('palm', v, 250)).toBe('plain');
    expect(resolveBarcodeShape('off', v, 250)).toBe('off');
    expect(resolveBarcodeShape('plain', v, 250)).toBe('plain');
    expect(RECEIPT_BARCODE_SHAPES.length).toBe(24);
  });
});
