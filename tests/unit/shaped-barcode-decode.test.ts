/**
 * Scan-proof gate: every shape x several order numbers is rasterised and
 * decoded by zxing; it must give back the exact order number. A shape that
 * cannot decode does not ship (remove it from the barkod extraction map).
 */
import { describe, it, expect } from 'vitest';
import { Resvg } from '@resvg/resvg-js';
import { readBarcodes } from 'zxing-wasm/reader';
import { renderBarcodeSvg, RECEIPT_BARCODE_SHAPES } from '../../packages/shared/src/barcode';

const VALUES = ['ORD-MJ4K9L2A-AB3XY', '1234567890', 'ORD-1', 'ORD-MJ4K9L2A-AB3XY-0042-LONGTEST'];

async function decode(svg: string, widthPx: number): Promise<string[]> {
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: widthPx },
    background: 'white',
    font: { loadSystemFonts: false },
  })
    .render()
    .asPng();
  // zxing-wasm reads encoded image bytes directly
  const res = await readBarcodes(new Blob([png], { type: 'image/png' }), {
    formats: ['Code128'],
    tryHarder: true,
  });
  return res.map(r => r.text);
}

describe('shaped barcode decode gate', () => {
  for (const shape of ['plain', ...RECEIPT_BARCODE_SHAPES]) {
    for (const value of VALUES) {
      it(`${shape} decodes ${value}`, async () => {
        const svg = renderBarcodeSvg({ value, shape, ink: '#111111' });
        // 1600px wide ~ a 7cm receipt at 580 dpi-equivalent camera detail
        expect(await decode(svg, 1600)).toContain(value);
      });
    }
  }
});

describe('decode gate negative controls (the gate can fail)', () => {
  it('a different number does not decode to the expected one', async () => {
    const out = await decode(renderBarcodeSvg({ value: 'ORD-AAAA', shape: 'palm', ink: '#111' }), 1600);
    expect(out).toContain('ORD-AAAA');
    expect(out).not.toContain('ORD-BBBB');
  });
  it('with the bars blanked nothing decodes', async () => {
    const svg = renderBarcodeSvg({ value: 'ORD-AAAA', shape: 'palm', ink: '#111' }).replace(/fill="#111"/g, 'fill="none"');
    expect(await decode(svg, 1600)).toEqual([]);
  });
  it('still decodes at a phone-camera-ish 700px wide', async () => {
    for (const shape of ['palm', 'ghost', 'cloud']) {
      expect(await decode(renderBarcodeSvg({ value: 'ORD-MJ4K9L2A-AB3XY', shape, ink: '#111' }), 700)).toContain('ORD-MJ4K9L2A-AB3XY');
    }
  });
});
