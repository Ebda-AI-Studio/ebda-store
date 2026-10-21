/**
 * The barcode as a PNG for emails (mail clients drop inline SVG), rendered
 * WITHOUT an SVG engine so it runs on the Cloudflare Worker: bars are plain
 * rectangles, shapes are the 1-bit silhouettes pre-rendered once
 * (`shape-masks.generated.ts`, scripts/gen-barcode-masks.mjs). Same layout as
 * the SVG renderer (`renderBarcodeSvg`): decoration bars masked to the shape
 * above a full-width, unmasked scan zone, 10-module quiet zones, the compact
 * scan code. 8-bit grayscale, black on white, NO text and no metadata chunks:
 * the number is in the email body and the alt text, never in the image.
 *
 * `node:zlib` is the Worker's `nodejs_compat` zlib (deflate/inflate sync).
 */
import { deflateSync, inflateSync } from 'node:zlib';
import {
  BARCODE_DISPLAY_PX,
  BARCODE_PAD,
  BARCODE_QUIET,
  BARCODE_ZONE,
  barcodeShapeData,
  code128Modules,
  resolveBarcodeShape,
  scanCodeFor,
} from '@ebda/shared';
import { SHAPE_MASKS } from './shape-masks.generated';

/** Pixel width of a shaped PNG (shown at BARCODE_DISPLAY_PX.email = half of it, i.e. 2x). */
export const EMAIL_PNG_WIDTH = BARCODE_DISPLAY_PX.email * 2;
/** Plain bars: the largest whole-pixel module that keeps the image <= EMAIL_PNG_WIDTH. */
const PLAIN_BAR_HEIGHT_MODULES = 24;

export interface BarcodePng {
  png: Uint8Array;
  width: number;
  height: number;
  /** The shape actually drawn (`plain` when the requested one broke the module floor). */
  shape: string;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** 8-bit grayscale PNG (`pixels` = width*height bytes, row-major). IHDR, IDAT, IEND only. */
export function encodeGrayPng(width: number, height: number, pixels: Uint8Array): Uint8Array {
  const raw = new Uint8Array((width + 1) * height); // filter byte 0 per row
  for (let y = 0; y < height; y++)
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const parts = [
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Per-pixel-column bar coverage 0..1 for `mods` laid from `x0` with `mw` px per module. */
function columnCoverage(mods: boolean[], width: number, x0: number, mw: number): Float32Array {
  const cov = new Float32Array(width);
  for (let i = 0; i < mods.length; ) {
    if (!mods[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < mods.length && mods[j]) j++;
    const a = x0 + i * mw;
    const b = x0 + j * mw;
    for (let x = Math.max(0, Math.floor(a)); x < Math.min(width, Math.ceil(b)); x++) {
      cov[x]! += Math.max(0, Math.min(b, x + 1) - Math.max(a, x));
    }
    i = j;
  }
  return cov;
}

const grey = (cov: number) => 255 - Math.round(255 * Math.min(1, cov));

function plainPng(mods: boolean[]): BarcodePng {
  const total = mods.length + BARCODE_QUIET * 2;
  const mp = Math.max(1, Math.floor(EMAIL_PNG_WIDTH / total));
  const width = total * mp;
  const height = PLAIN_BAR_HEIGHT_MODULES * mp * 2;
  const row = new Uint8Array(width).fill(255);
  mods.forEach((bar, i) => {
    if (bar) row.fill(0, (BARCODE_QUIET + i) * mp, (BARCODE_QUIET + i + 1) * mp);
  });
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) pixels.set(row, y * width);
  return { png: encodeGrayPng(width, height, pixels), width, height, shape: 'plain' };
}

function unpackMask(z: string, w: number, h: number): Uint8Array {
  const bits = inflateSync(Buffer.from(z, 'base64'));
  const rowBytes = Math.ceil(w / 8);
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      m[y * w + x] = (bits[y * rowBytes + (x >> 3)]! >> (7 - (x & 7))) & 1;
  return m;
}

export function renderBarcodePng(opts: { value: string; shape?: string }): BarcodePng {
  const mods = code128Modules(scanCodeFor(opts.value));
  const shape = resolveBarcodeShape(opts.shape ?? 'plain', opts.value, BARCODE_DISPLAY_PX.email);
  const data = shape === 'plain' ? undefined : barcodeShapeData(shape);
  const mask = data ? SHAPE_MASKS[shape] : undefined;
  if (!data || !mask) return plainPng(mods);

  const { w: width, h: height } = mask;
  const S = width / (data.w + BARCODE_PAD * 2); // px per shape unit
  const mw = (data.w * S) / (mods.length + BARCODE_QUIET * 2);
  const x0 = BARCODE_PAD * S + BARCODE_QUIET * mw;
  const cov = columnCoverage(mods, width, x0, mw);
  const zoneTop = Math.round((BARCODE_PAD + data.h - BARCODE_ZONE) * S);
  const zoneBottom = Math.round((BARCODE_PAD + data.h) * S);
  const m = unpackMask(mask.z, width, height);
  const pixels = new Uint8Array(width * height).fill(255);
  for (let y = 0; y < height; y++) {
    const inZone = y >= zoneTop && y < zoneBottom;
    for (let x = 0; x < width; x++) {
      if (inZone || m[y * width + x]) pixels[y * width + x] = grey(cov[x]!);
    }
  }
  return { png: encodeGrayPng(width, height, pixels), width, height, shape };
}
