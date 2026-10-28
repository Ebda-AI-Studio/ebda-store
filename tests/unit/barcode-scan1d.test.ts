/**
 * The in-house 1D reader (Ruling BARCODE-1a) against OUR OWN encoders: every BARKOD shape at every
 * real size, Code 128 sets B/C, EAN-13 / UPC-A, plus the failures that must FAIL (no quiet zone,
 * faint print, inverted print, a corrupted bar, a single lucky scanline). A differential check
 * against zxing (test-only) proves the reader and a production reader agree.
 */
import { describe, it, expect } from 'vitest';
import { Resvg } from '@resvg/resvg-js';
import { decodeCode128 } from '../helpers/zxing';
import {
  BARCODE_DISPLAY_PX,
  RECEIPT_BARCODE_SHAPES,
  code128Modules,
  decodeLinear,
  EAN_R,
  ean13Modules,
  matchCode128Symbol,
  makeInStoreEan13,
  renderBarcodeSvg,
  scanCodeFor,
  selfCheckLinear,
  type Image1d,
} from '../../packages/shared/src/barcode';

/** Draw modules as a flat RGBA image: `scale` px per module, quiet zones, `h` rows. */
function synth(
  mods: boolean[],
  opts: { scale?: number; quiet?: number; h?: number; ink?: number; paper?: number } = {}
): Image1d {
  const scale = opts.scale ?? 3;
  const quiet = opts.quiet ?? 10;
  const h = opts.h ?? 40;
  const ink = opts.ink ?? 20;
  const paper = opts.paper ?? 255;
  const width = Math.round((mods.length + quiet * 2) * scale);
  const data = new Uint8ClampedArray(width * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < width; x++) {
      const m = Math.floor(x / scale) - quiet;
      const dark = m >= 0 && m < mods.length && mods[m];
      const v = dark ? ink : paper;
      data.set([v, v, v, 255], (y * width + x) * 4);
    }
  return { width, height: h, data };
}

function raster(svg: string, widthPx: number): Image1d {
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: widthPx },
    background: 'white',
    font: { loadSystemFonts: false },
  }).render();
  return { width: r.width, height: r.height, data: r.pixels };
}

const cropLeft = (img: Image1d, px: number): Image1d => {
  const width = img.width - px;
  const data = new Uint8ClampedArray(width * img.height * 4);
  const src = img.data as Uint8ClampedArray;
  for (let y = 0; y < img.height; y++)
    data.set(
      src.subarray((y * img.width + px) * 4, (y * img.width + img.width) * 4),
      y * width * 4
    );
  return { width, height: img.height, data };
};

describe('synthetic Code 128', () => {
  for (const value of ['ORD-T5JK9Q-AB3XY', 'A-1', '1234567890', '123456', 'ab 12 CD~', 'x']) {
    for (const scale of [2, 3, 5]) {
      it(`reads ${value} at ${scale}px/module`, () => {
        const r = decodeLinear(synth(code128Modules(value), { scale }));
        expect(r.ok).toBe(true);
        expect(r.value).toBe(value);
        expect(r.kind).toBe('code128');
        expect(r.agree).toBeGreaterThanOrEqual(2);
      });
    }
  }
  it('reads a code printed right to left (rotated 180 degrees)', () => {
    const r = decodeLinear(synth([...code128Modules('ORD-1')].reverse()));
    expect(r.value).toBe('ORD-1');
  });
});

describe('synthetic EAN-13 / UPC-A', () => {
  const codes = [
    '4006381333931',
    '5901234123457',
    makeInStoreEan13(20, 1),
    makeInStoreEan13(29, 1234567),
  ];
  for (const v of codes) {
    it(`reads EAN-13 ${v}`, () => {
      const r = decodeLinear(synth(ean13Modules(v), { quiet: 11, scale: 3 }));
      expect(r.ok).toBe(true);
      expect(r.kind).toBe('ean13');
      expect(r.value).toBe(v);
    });
  }
  it('a UPC-A (EAN-13 with a leading 0) matches its 12-digit form', () => {
    const upc = '036000291452';
    const img = synth(ean13Modules(`0${upc}`), { quiet: 9 });
    expect(selfCheckLinear(img, upc).ok).toBe(true);
    expect(selfCheckLinear(img, `0${upc}`).ok).toBe(true);
    expect(selfCheckLinear(img, '036000291453').ok).toBe(false);
  });
});

describe('failures that must FAIL', () => {
  const ok = () => synth(code128Modules('ORD-TEST-1'));
  it('sanity: the control reads', () => expect(decodeLinear(ok()).ok).toBe(true));

  it('no quiet zone on the left', () => {
    expect(decodeLinear(synth(code128Modules('ORD-TEST-1'), { quiet: 1 })).ok).toBe(false);
    expect(decodeLinear(cropLeft(ok(), 28)).ok).toBe(false);
  });
  it('no quiet zone on the right (EAN)', () => {
    const img = synth(ean13Modules('4006381333931'), { quiet: 11 });
    const width = img.width - 11 * 3 + 3;
    const data = new Uint8ClampedArray(width * img.height * 4);
    const src = img.data as Uint8ClampedArray;
    for (let y = 0; y < img.height; y++)
      data.set(src.subarray(y * img.width * 4, (y * img.width + width) * 4), y * width * 4);
    expect(decodeLinear({ width, height: img.height, data }).ok).toBe(false);
  });
  it('faint print (low contrast)', () => {
    const r = decodeLinear(synth(code128Modules('ORD-TEST-1'), { ink: 190 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('low-contrast');
  });
  it('inverted print (light bars on dark paper)', () => {
    expect(decodeLinear(synth(code128Modules('ORD-TEST-1'), { ink: 255, paper: 10 })).ok).toBe(
      false
    );
  });
  it('a corrupted module fails the checksum', () => {
    const mods = code128Modules('ORD-TEST-1');
    mods[40] = !mods[40];
    mods[41] = !mods[41];
    expect(decodeLinear(synth(mods)).ok).toBe(false);
  });
  it('a bad EAN check digit is not a code', () => {
    // 4006381333931 with its last digit (1) replaced by a clean, valid-looking 2: structure is
    // perfect, only the check digit is wrong.
    const bad = [...ean13Modules('4006381333931')];
    EAN_R[2].split('').forEach((b, i) => (bad[85 + i] = b === '1'));
    expect(decodeLinear(synth(bad, { quiet: 11 })).ok).toBe(false);
  });
  it('a symbol that fits no Code 128 pattern is rejected, not rounded to the nearest', () => {
    expect(matchCode128Symbol([2, 1, 2, 2, 2, 2])).toBe(0); // control: a real pattern (value 0)
    expect(matchCode128Symbol([6, 1, 1, 1, 1, 1])).toBeNull();
  });
  it('one lucky scanline is not enough: needs 2 to agree', () => {
    const img = synth(code128Modules('ORD-TEST-1'), { h: 40 });
    // blank every row except one
    const keep = Math.floor(img.height * 0.5);
    for (let y = 0; y < img.height; y++)
      if (y !== keep)
        for (let x = 0; x < img.width; x++)
          (img.data as Uint8ClampedArray).set([255, 255, 255, 255], (y * img.width + x) * 4);
    const one = decodeLinear(img, { lines: 15 });
    expect(one.ok).toBe(false);
    expect(decodeLinear(img, { lines: 40, minAgree: 1 }).ok).toBe(true); // control: the single row does decode
  });
  it('reads the wrong value => selfCheck fails', () => {
    expect(selfCheckLinear(ok(), 'ORD-TEST-2').ok).toBe(false);
    expect(selfCheckLinear(ok(), 'ORD-TEST-1').ok).toBe(true);
  });
  it('a blank image is not a code', () => {
    expect(
      decodeLinear({ width: 50, height: 10, data: new Uint8ClampedArray(2000).fill(255) }).ok
    ).toBe(false);
  });
});

describe('every BARKOD shape x real size (scan zone)', () => {
  const VALUES = ['ORD-T5JK9Q-AB3XY', 'ORD-ZZZZZZ-ZZZZZ'];
  const SIZES = [
    {
      name: 'storefront receipt 1x',
      px: BARCODE_DISPLAY_PX.storefrontReceipt,
      raster: BARCODE_DISPLAY_PX.storefrontReceipt,
    },
    { name: 'email 2x', px: BARCODE_DISPLAY_PX.email, raster: BARCODE_DISPLAY_PX.email * 2 },
    {
      name: 'label 4x',
      px: BARCODE_DISPLAY_PX.packingSlipLabel,
      raster: BARCODE_DISPLAY_PX.packingSlipLabel * 4,
    },
  ];
  for (const size of SIZES)
    for (const shape of ['plain', ...RECEIPT_BARCODE_SHAPES])
      for (const value of VALUES)
        it(`${size.name}: ${shape} ${value}`, () => {
          const svg = renderBarcodeSvg({ value, shape, ink: '#141414', displayPx: size.px });
          const r = decodeLinear(raster(svg, size.raster));
          expect(r.value).toBe(scanCodeFor(value));
          expect(r.agree).toBeGreaterThanOrEqual(2);
        });

  it('differential: agrees with zxing on rendered shapes', async () => {
    for (const shape of ['plain', 'palm', RECEIPT_BARCODE_SHAPES[3]]) {
      const svg = renderBarcodeSvg({ value: VALUES[0], shape, ink: '#141414', displayPx: 360 });
      const png = new Resvg(svg, {
        fitTo: { mode: 'width', value: 720 },
        background: 'white',
        font: { loadSystemFonts: false },
      })
        .render()
        .asPng();
      expect((await decodeCode128(png))[0]).toBe(decodeLinear(raster(svg, 720)).value);
    }
  });

  it('a shape too coarse for its size fails the check instead of printing (module floor)', () => {
    const svg = renderBarcodeSvg({
      value: VALUES[0],
      shape: RECEIPT_BARCODE_SHAPES[0],
      ink: '#141414',
    });
    expect(decodeLinear(raster(svg, 90)).ok).toBe(false); // ~0.3 px per module
  });
});
