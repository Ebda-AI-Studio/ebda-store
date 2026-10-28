/**
 * QR design -> a flat list of painted shapes (QR-1). One scene feeds three renderers: SVG
 * (`svg.ts`), the admin canvas (PNG/PDF) and the pure-JS rasteriser the scan self-check decodes
 * (`raster.ts`), so what is checked is what is drawn. 1 module = 10 units.
 */
import { encodeQR } from 'qr';
import { HEX_COLOR, QR_CTA_MAX, type QrDesign } from './schema';
import { readableOn } from './contrast';

export const MODULE = 10;
export const QUIET_MODULES = 4;
/** Share of the code's area the logo hole may clear. ECC H repairs 30% of codewords; stay well under. */
export const LOGO_MAX_AREA = 0.16;

export type Shape =
  | { t: 'rect'; x: number; y: number; w: number; h: number; r: number; fill: string }
  | { t: 'circle'; cx: number; cy: number; r: number; fill: string };

export type Scene = {
  width: number;
  height: number;
  shapes: Shape[];
  /** The code itself (quiet zone included), for the decoder crop. */
  code: { x: number; y: number; size: number };
  /** Square hole cleared for the logo image (null = no logo). */
  logo: { x: number; y: number; size: number } | null;
  label: {
    x: number;
    y: number;
    w: number;
    h: number;
    text: string;
    color: string;
    rtl: boolean;
  } | null;
  modules: number;
  ecc: 'medium' | 'high';
};

function assertHex(c: string): void {
  if (!HEX_COLOR.test(c)) throw new Error('qr: colour must be #rrggbb');
}

function inFinder(r: number, c: number, n: number): boolean {
  const tl = r < 7 && c < 7;
  const tr = r < 7 && c >= n - 7;
  const bl = r >= n - 7 && c < 7;
  return tl || tr || bl;
}

function finder(x: number, y: number, kind: QrDesign['finder'], fg: string, bg: string): Shape[] {
  const s = MODULE;
  const out: Shape[] = [];
  if (kind === 'circle') {
    out.push({ t: 'circle', cx: x + 3.5 * s, cy: y + 3.5 * s, r: 3.5 * s, fill: fg });
    out.push({ t: 'circle', cx: x + 3.5 * s, cy: y + 3.5 * s, r: 2.5 * s, fill: bg });
    out.push({ t: 'circle', cx: x + 3.5 * s, cy: y + 3.5 * s, r: 1.5 * s, fill: fg });
    return out;
  }
  const ro = kind === 'rounded' ? 2 * s : 0;
  out.push({ t: 'rect', x, y, w: 7 * s, h: 7 * s, r: ro, fill: fg });
  out.push({ t: 'rect', x: x + s, y: y + s, w: 5 * s, h: 5 * s, r: ro ? 1.2 * s : 0, fill: bg });
  out.push({ t: 'rect', x: x + 2 * s, y: y + 2 * s, w: 3 * s, h: 3 * s, r: ro ? s : 0, fill: fg });
  return out;
}

/** Odd module count of the logo hole: <= LOGO_MAX_AREA of the grid, at least 3. */
export function logoHoleModules(n: number): number {
  let side = Math.floor(Math.sqrt(LOGO_MAX_AREA) * n);
  if (side % 2 === 0) side -= 1;
  return Math.max(3, side);
}

export function buildScene(payload: string, d: QrDesign): Scene {
  assertHex(d.fg);
  assertHex(d.bg);
  assertHex(d.frameColor);
  const ecc = d.logo ? 'high' : 'medium';
  // border must be >= 1; the library adds the ring after drawing, so slice it off.
  const padded = encodeQR(payload, 'raw', { ecc, border: 1 }) as boolean[][];
  const grid = padded.slice(1, -1).map(row => row.slice(1, -1));
  const n = grid.length;
  const codeSize = (n + 2 * QUIET_MODULES) * MODULE;

  const framed = d.frame !== 'none';
  const pad = d.frame === 'card' ? 3 * MODULE : 0;
  const bandH = framed && d.cta ? 7 * MODULE : 0;
  const width = codeSize + 2 * pad;
  const height = codeSize + 2 * pad + bandH + (d.frame === 'badge' && d.cta ? MODULE : 0);

  const shapes: Shape[] = [];
  const outer = d.frame === 'card' ? d.frameColor : d.bg;
  shapes.push({
    t: 'rect',
    x: 0,
    y: 0,
    w: width,
    h: height,
    r: d.frame === 'card' ? 3 * MODULE : 0,
    fill: outer,
  });
  if (d.frame === 'badge')
    shapes[0] = { t: 'rect', x: 0, y: 0, w: width, h: height, r: 0, fill: d.bg };
  // the code plate (white-ish bg) with a quiet zone
  const cx0 = pad;
  const cy0 = pad;
  shapes.push({
    t: 'rect',
    x: cx0,
    y: cy0,
    w: codeSize,
    h: codeSize,
    r: d.frame === 'card' ? 1.5 * MODULE : 0,
    fill: d.bg,
  });

  const ox = cx0 + QUIET_MODULES * MODULE;
  const oy = cy0 + QUIET_MODULES * MODULE;

  let logo: Scene['logo'] = null;
  let holeMin = -1;
  let holeMax = -1;
  if (d.logo) {
    const hole = logoHoleModules(n);
    holeMin = Math.floor((n - hole) / 2);
    holeMax = holeMin + hole - 1;
    logo = { x: ox + holeMin * MODULE, y: oy + holeMin * MODULE, size: hole * MODULE };
  }

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!grid[r][c] || inFinder(r, c, n)) continue;
      if (d.logo && r >= holeMin && r <= holeMax && c >= holeMin && c <= holeMax) continue;
      const x = ox + c * MODULE;
      const y = oy + r * MODULE;
      if (d.style === 'dots') {
        shapes.push({
          t: 'circle',
          cx: x + MODULE / 2,
          cy: y + MODULE / 2,
          r: MODULE * 0.46,
          fill: d.fg,
        });
      } else {
        shapes.push({
          t: 'rect',
          x,
          y,
          w: MODULE,
          h: MODULE,
          r: d.style === 'rounded' ? MODULE * 0.3 : 0,
          fill: d.fg,
        });
      }
    }
  }
  shapes.push(...finder(ox, oy, d.finder, d.fg, d.bg));
  shapes.push(...finder(ox + (n - 7) * MODULE, oy, d.finder, d.fg, d.bg));
  shapes.push(...finder(ox, oy + (n - 7) * MODULE, d.finder, d.fg, d.bg));

  let label: Scene['label'] = null;
  if (framed && d.cta) {
    const text = d.cta.text.slice(0, QR_CTA_MAX);
    if (d.frame === 'card') {
      label = {
        x: pad,
        y: pad + codeSize,
        w: codeSize,
        h: bandH + pad - 1.5 * MODULE,
        text,
        color: readableOn(d.frameColor),
        rtl: d.cta.lang === 'ar',
      };
    } else {
      const by = codeSize + MODULE / 2;
      shapes.push({
        t: 'rect',
        x: MODULE * 2,
        y: by,
        w: width - 4 * MODULE,
        h: bandH,
        r: bandH / 2,
        fill: d.frameColor,
      });
      label = {
        x: MODULE * 2,
        y: by,
        w: width - 4 * MODULE,
        h: bandH,
        text,
        color: readableOn(d.frameColor),
        rtl: d.cta.lang === 'ar',
      };
    }
  }

  return {
    width,
    height,
    shapes,
    code: { x: cx0, y: cy0, size: codeSize },
    logo,
    label,
    modules: n,
    ecc,
  };
}
