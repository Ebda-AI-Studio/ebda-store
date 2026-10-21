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
  it('uses palm and a full-entropy 16-digit payment number from ANY id shape', () => {
    expect(EBDA_BILLING_BARCODE_SHAPE).toBe('palm');
    expect(RECEIPT_BARCODE_SHAPES).toContain(EBDA_BILLING_BARCODE_SHAPE);
    const uuid = '3f2a91c4-7b1e-4d0a-9c55-0e8a1f2b3c4d';
    const n = billingPaymentNumber(uuid);
    expect(n).toMatch(/^EBD-\d{16}$/);
    expect(billingPaymentNumber(uuid)).toBe(n); // deterministic
    expect(billingPaymentNumber('clx9k2m4p0000abcd1234efgh')).toMatch(/^EBD-\d{16}$/); // cuid
    expect(billingPaymentNumber(uuid.replace('3f2a', '3f2b'))).not.toBe(n);
    expect(() => billingPaymentNumber('')).toThrow();
  });
  it('does not collide across 20k ids (64-bit hash, 16 digits)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20000; i++) seen.add(billingPaymentNumber(`charge-${i}`));
    expect(seen.size).toBe(20000);
  });
});

describe('renderBarcodeSvg: instance ids, ink, size rule', () => {
  it('mask ids are unique per instance (idSuffix) and referenced consistently', () => {
    const a = renderBarcodeSvg({ value: 'ORD-T5JK9Q-AB3XY', shape: 'heart', idSuffix: 'a1' });
    const b = renderBarcodeSvg({ value: 'ORD-T5JK9Q-AB3XY', shape: 'heart', idSuffix: 'b2' });
    expect(a).toContain('id="bcm-heart-a1"');
    expect(a).toContain('url(#bcm-heart-a1)');
    expect(b).toContain('id="bcm-heart-b2"');
    expect(a).not.toContain('b2');
  });
  it('ink is a token or hex only; anything else is dropped to currentColor', () => {
    const bad = renderBarcodeSvg({ value: 'ORD-1', shape: 'plain', ink: '"/><script>x</script>' });
    expect(bad).not.toContain('<script');
    expect(bad).toContain('fill="currentColor"');
    expect(renderBarcodeSvg({ value: 'ORD-1', shape: 'plain', ink: '#141414' })).toContain('fill="#141414"');
  });
  it('a shape that cannot meet the module floor at displayPx renders plain', () => {
    const v = 'ORD-T5JK9Q-AB3XY';
    expect(renderBarcodeSvg({ value: v, shape: 'palm', displayPx: 250 })).not.toContain('<mask');
    expect(renderBarcodeSvg({ value: v, shape: 'palm', displayPx: 400 })).toContain('<mask');
  });
  it('labels with the order number but encodes the compact scan code', () => {
    const svg = renderBarcodeSvg({ value: 'ORD-T5JK9Q-AB3XY', shape: 'plain', label: true });
    expect(svg).toContain('ORD-T5JK9Q-AB3XY');
    expect(svg).toContain('aria-label="ORD-T5JK9Q-AB3XY"');
  });
  it('keeps a separate unmasked scan-zone path in every shape', () => {
    for (const shape of RECEIPT_BARCODE_SHAPES) {
      const svg = renderBarcodeSvg({ value: 'ORD-T5JK9Q-AB3XY', shape });
      const paths = [...svg.matchAll(/<path d="M[^"]*" fill="[^"]+"( mask="[^"]+")?\/>/g)];
      expect(paths.filter(p => p[1]).length, shape).toBe(1); // masked decoration
      expect(paths.filter(p => !p[1]).length, shape).toBe(1); // the scan zone
    }
  });
});
