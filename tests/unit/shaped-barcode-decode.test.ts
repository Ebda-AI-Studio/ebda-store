/**
 * Scan-proof gate at the REAL display sizes (Ruling BARCODE-4), not vector size.
 * Every shape x real-format order numbers is rendered the way each surface
 * renders it (`displayPx` applies the module-width floor, so a shape that is
 * too wide-for-its-bars falls back to plain), rasterised at the surface's CSS
 * width (1x, the worst case; email = the 2x PNG), and decoded with zxing: it
 * must equal the compact scan code, and map back to the order number.
 *
 * The scan zone is gated on its own: the decoration is stripped and the zone
 * alone must decode; deleting the zone path makes that fail (negative control).
 */
import { describe, it, expect } from 'vitest';
import { Resvg } from '@resvg/resvg-js';
import { decodeCode128 } from '../helpers/zxing';
import {
  renderBarcodeSvg,
  RECEIPT_BARCODE_SHAPES,
  BARCODE_DISPLAY_PX,
  billingPaymentNumber,
  EBDA_BILLING_BARCODE_SHAPE,
  scanCodeFor,
  orderNumberFromScanCode,
  resolveBarcodeShape,
} from '../../packages/shared/src/barcode';

const REAL = ['ORD-T5JK9Q-AB3XY', 'ORD-000000-00000', 'ORD-ZZZZZZ-ZZZZZ'];
const SHAPES = ['plain', ...RECEIPT_BARCODE_SHAPES];

async function decode(svg: string, widthPx: number): Promise<string[]> {
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: widthPx },
    background: 'white',
    font: { loadSystemFonts: false },
  })
    .render()
    .asPng();
  return decodeCode128(png);
}

const MASKED = /<path d="M[^"]*" fill="[^"]+" mask="[^"]+"\/>/;
const ZONE = /<path d="M[^"]*" fill="[^"]+"\/>/;
const zoneOnly = (svg: string) => svg.replace(MASKED, '');

const SURFACES = [
  {
    name: 'storefront receipt',
    px: BARCODE_DISPLAY_PX.storefrontReceipt,
    raster: BARCODE_DISPLAY_PX.storefrontReceipt,
  },
  { name: 'email png (2x)', px: BARCODE_DISPLAY_PX.email, raster: BARCODE_DISPLAY_PX.email * 2 },
] as const;

describe('decode gate at real display sizes', () => {
  for (const surface of SURFACES) {
    for (const shape of SHAPES) {
      for (const value of REAL) {
        it(`${surface.name}: ${shape} ${value}`, async () => {
          const svg = renderBarcodeSvg({ value, shape, ink: '#141414', displayPx: surface.px });
          const out = await decode(svg, surface.raster);
          expect(out).toContain(scanCodeFor(value));
          expect(orderNumberFromScanCode(out[0]!)).toBe(value);
          // the scan zone ALONE carries the code (decoration stripped)
          expect(await decode(zoneOnly(svg), surface.raster)).toContain(scanCodeFor(value));
        });
      }
    }
  }

  it('invoice width: every shape decodes', async () => {
    for (const shape of SHAPES) {
      const svg = renderBarcodeSvg({
        value: REAL[0]!,
        shape,
        ink: '#141414',
        displayPx: BARCODE_DISPLAY_PX.invoice,
      });
      expect(await decode(zoneOnly(svg), BARCODE_DISPLAY_PX.invoice), shape).toContain(
        scanCodeFor(REAL[0]!)
      );
    }
  });

  it('billing receipt: the palm payment number decodes at receipt width and in the email', async () => {
    const value = billingPaymentNumber('3f2a91c4-7b1e-4d0a-9c55-0e8a1f2b3c4d');
    const svg = renderBarcodeSvg({
      value,
      shape: EBDA_BILLING_BARCODE_SHAPE,
      ink: '#141414',
      displayPx: BARCODE_DISPLAY_PX.billingReceipt,
    });
    expect(svg).toContain('<mask'); // palm meets the floor at this size: it stays a palm
    expect(await decode(zoneOnly(svg), BARCODE_DISPLAY_PX.billingReceipt)).toContain(
      scanCodeFor(value)
    );
    expect(await decode(svg, BARCODE_DISPLAY_PX.billingReceipt * 2)).toContain(scanCodeFor(value));
  });
});

describe('negative controls (the gate can fail)', () => {
  it('a different number does not decode to the expected one', async () => {
    const out = await decode(
      renderBarcodeSvg({ value: REAL[0]!, shape: 'palm', ink: '#111', displayPx: 360 }),
      720
    );
    expect(out).not.toContain(scanCodeFor(REAL[1]!));
  });
  it('deleting the scan-zone path makes the zone-only decode fail', async () => {
    const svg = renderBarcodeSvg({ value: REAL[0]!, shape: 'heart', ink: '#111', displayPx: 360 });
    expect(ZONE.test(zoneOnly(svg))).toBe(true);
    const noZone = zoneOnly(svg).replace(ZONE, '');
    expect(await decode(noZone, 720)).toEqual([]);
  });
  it('blanked bars decode to nothing', async () => {
    const svg = renderBarcodeSvg({
      value: REAL[0]!,
      shape: 'palm',
      ink: '#111',
      displayPx: 360,
    }).replace(/fill="#111"/g, 'fill="none"');
    expect(await decode(svg, 720)).toEqual([]);
  });
});

describe('which shapes meet the floor', () => {
  it('reports the fallbacks (informational, pinned so a change is noticed)', () => {
    const fb = (px: number) =>
      RECEIPT_BARCODE_SHAPES.filter(s => resolveBarcodeShape(s, REAL[0]!, px) !== s);
    // pinned lists: update deliberately
    expect(fb(BARCODE_DISPLAY_PX.storefrontReceipt)).toEqual(fb(BARCODE_DISPLAY_PX.billingReceipt));
    expect(fb(BARCODE_DISPLAY_PX.storefrontReceipt)).not.toContain('palm');
  });
});

describe('packing slip sizes', () => {
  for (const [name, px] of [
    ['A4 slip', BARCODE_DISPLAY_PX.packingSlipA4],
    ['4x6 label', BARCODE_DISPLAY_PX.packingSlipLabel],
  ] as const) {
    it(`${name} (${px}px): every shape (or its plain fallback) decodes, zone alone`, async () => {
      for (const shape of SHAPES) {
        for (const value of REAL) {
          const svg = renderBarcodeSvg({ value, shape, ink: '#111111', displayPx: px });
          expect(await decode(zoneOnly(svg), px), `${name} ${shape} ${value}`).toContain(
            scanCodeFor(value)
          );
        }
      }
    });
  }
});
