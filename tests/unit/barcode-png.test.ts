/**
 * Email barcode PNGs: rendered with no SVG engine at runtime (a small
 * rasteriser + the pre-rendered shape masks), so it runs on the Worker. The
 * gate is the same as the SVG one: every shape x real-format numbers decodes,
 * here directly from the PNG bytes, with the decoration masked away too.
 */
import { describe, it, expect } from 'vitest';
import { readBarcodes } from 'zxing-wasm/reader';
import { inflateSync } from 'node:zlib';
import {
  RECEIPT_BARCODE_SHAPES,
  scanCodeFor,
  orderNumberFromScanCode,
  billingPaymentNumber,
  EBDA_BILLING_BARCODE_SHAPE,
} from '../../packages/shared/src/barcode';
import {
  renderBarcodePng,
  encodeGrayPng,
  EMAIL_PNG_WIDTH,
} from '../../apps/api/src/lib/barcode-png/render';

const REAL = ['ORD-T5JK9Q-AB3XY', 'ORD-000000-00000', 'ORD-ZZZZZZ-ZZZZZ'];

async function decodePng(png: Uint8Array): Promise<string[]> {
  const res = await readBarcodes(new Blob([png], { type: 'image/png' }), {
    formats: ['Code128'],
    tryHarder: true,
  });
  return res.map(r => r.text);
}

describe('renderBarcodePng', () => {
  it('is a valid PNG of about 600-720px, grayscale, with its real size reported', () => {
    const out = renderBarcodePng({ value: REAL[0]!, shape: 'plain' });
    expect(Array.from(out.png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(out.width).toBeGreaterThanOrEqual(600);
    expect(out.width).toBeLessThanOrEqual(EMAIL_PNG_WIDTH);
    const dv = new DataView(out.png.buffer, out.png.byteOffset);
    expect(dv.getUint32(16)).toBe(out.width);
    expect(dv.getUint32(20)).toBe(out.height);
    expect(out.png[24]).toBe(8); // bit depth
    expect(out.png[25]).toBe(0); // grayscale
    expect(out.png.length).toBeLessThan(60_000);
    // IDAT inflates to exactly (width + 1) * height bytes
    const idatStart = out.png.indexOf(0x49, 33); // 'I' of IDAT after IHDR
    expect(idatStart).toBeGreaterThan(0);
    expect(inflateSync(Buffer.from(out.png.slice(idatStart + 4, out.png.length - 12))).length).toBe(
      (out.width + 1) * out.height
    );
  });

  for (const shape of ['plain', ...RECEIPT_BARCODE_SHAPES]) {
    it(`${shape}: decodes every real-format number from the PNG`, async () => {
      for (const value of REAL) {
        const out = renderBarcodePng({ value, shape });
        const text = await decodePng(out.png);
        expect(text, `${shape} ${value}`).toContain(scanCodeFor(value));
        expect(orderNumberFromScanCode(text[0]!)).toBe(value);
      }
    });
  }

  it('billing: the palm payment number decodes', async () => {
    const value = billingPaymentNumber('3f2a91c4-7b1e-4d0a-9c55-0e8a1f2b3c4d');
    const out = renderBarcodePng({ value, shape: EBDA_BILLING_BARCODE_SHAPE });
    expect(out.shape).toBe('palm');
    expect(await decodePng(out.png)).toContain(scanCodeFor(value));
  });

  it('a shape under the module floor at the email width renders (and reports) plain', () => {
    const out = renderBarcodePng({ value: 'ORD-1760000000000-ab12cd34', shape: 'palm' });
    expect(out.shape).toBe('plain');
  });

  it('carries no text and no metadata: only the image chunks', () => {
    const out = renderBarcodePng({ value: REAL[0]!, shape: 'palm' });
    const s = Buffer.from(out.png).toString('latin1');
    expect(s).not.toContain('tEXt');
    expect(s).not.toContain(REAL[0]!);
    expect(s).not.toContain('T5JK9Q');
  });

  it('a blank (white) image of the same size decodes to nothing: the gate can fail', async () => {
    const out = renderBarcodePng({ value: REAL[0]!, shape: 'plain' });
    const blank = encodeGrayPng(
      out.width,
      out.height,
      new Uint8Array(out.width * out.height).fill(255)
    );
    expect(await decodePng(out.png)).not.toEqual([]);
    expect(await decodePng(blank)).toEqual([]);
  });
});
