import { code128Modules } from './code128';
import { barcodeShapeData } from './shapes';
import { scanCodeFor } from './scan-code';
import { BARCODE_PAD, BARCODE_ZONE, BARCODE_QUIET, resolveBarcodeShape } from './sizing';

export interface RenderBarcodeOptions {
  value: string;
  /** `plain` or a shape id; anything unknown renders plain. */
  shape?: string;
  /** Show the human-readable number under the bars (default true). */
  label?: boolean;
  /** Bar colour: `currentColor` (default) or a hex colour; anything else is dropped to `currentColor`. */
  ink?: string;
  /** Unique per instance on a page (React `useId`); keeps mask ids from colliding. */
  idSuffix?: string;
  /**
   * Width in CSS px the SVG will be shown at. When set, a shape that would put
   * a module under `MIN_MODULE_CSS_PX` renders plain instead (Ruling BARCODE-4).
   */
  displayPx?: number;
}

const INK = /^(currentColor|#[0-9a-fA-F]{3,8})$/;
const ID = /[^A-Za-z0-9_-]/g;

const PAD = BARCODE_PAD;
const ZONE = BARCODE_ZONE;
const QUIET = BARCODE_QUIET;
const LABEL_H = 22;

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Bars as one path of rects; runs of black modules merge into one rect. */
function barsPath(mods: boolean[], x0: number, mw: number, y: number, h: number): string {
  let d = '';
  for (let i = 0; i < mods.length; ) {
    if (!mods[i]) { i++; continue; }
    let j = i;
    while (j < mods.length && mods[j]) j++;
    const x = +(x0 + i * mw).toFixed(3);
    const w = +((j - i) * mw).toFixed(3);
    d += `M${x} ${y}h${w}v${h}h${-w}z`;
    i = j;
  }
  return d;
}

/**
 * Real Code 128 of `value`, optionally clipped into a BARKOD shape. The bottom
 * `ZONE` units of a shape are a clean full-width scan zone with quiet zones;
 * the bars above are the same bars, masked to the silhouette.
 * Returns an SVG string (value is escaped); colour is `currentColor` by default.
 */
export function renderBarcodeSvg(opts: RenderBarcodeOptions): string {
  const { value, label = true } = opts;
  const ink = opts.ink && INK.test(opts.ink) ? opts.ink : 'currentColor';
  const shape =
    opts.displayPx !== undefined
      ? resolveBarcodeShape(opts.shape ?? 'plain', value, opts.displayPx)
      : (opts.shape ?? 'plain');
  // The compact reversible scan code is what the bars carry; the number is the label.
  const mods = code128Modules(scanCodeFor(value));
  const data = shape === 'plain' ? undefined : barcodeShapeData(shape);
  const text = (cx: number, y: number) =>
    label
      ? `<text x="${cx}" y="${y}" text-anchor="middle" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="15" font-weight="600" fill="${ink}" direction="ltr">${esc(value)}</text>`
      : '';
  const lab = label ? LABEL_H : 0;
  const attrs = `xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" role="img" aria-label="${esc(value)}"`;

  if (!data) {
    const W = 360;
    const mw = W / (mods.length + QUIET * 2);
    const H = 64;
    const bars = barsPath(mods, QUIET * mw, mw, 0, H);
    return `<svg ${attrs} viewBox="0 0 ${W} ${H + lab}"><path d="${bars}" fill="${ink}"/>${text(W / 2, H + 16)}</svg>`;
  }

  const { w, h, d } = data;
  const mw = w / (mods.length + QUIET * 2);
  const x0 = PAD + QUIET * mw;
  const zoneY = PAD + h - ZONE;
  const id = `bcm-${shape}${opts.idSuffix ? `-${opts.idSuffix.replace(ID, '')}` : ''}`;
  const mask =
    `<mask id="${id}" maskUnits="userSpaceOnUse"><rect width="${w + PAD * 2}" height="${h + PAD * 2}" fill="black"/>` +
    d.map(p => `<path d="${p}" fill="white" fill-rule="evenodd" transform="translate(${PAD},${PAD})"/>`).join('') +
    `<rect x="${PAD}" y="${zoneY}" width="${w}" height="${ZONE}" fill="white"/></mask>`;
  const deco = barsPath(mods, x0, mw, PAD, h - ZONE);
  const zone = barsPath(mods, x0, mw, zoneY, ZONE);
  return (
    `<svg ${attrs} viewBox="0 0 ${w + PAD * 2} ${h + PAD * 2 + lab}"><defs>${mask}</defs>` +
    `<path d="${deco}" fill="${ink}" mask="url(#${id})"/><path d="${zone}" fill="${ink}"/>` +
    `${text((w + PAD * 2) / 2, h + PAD * 2 + 14)}</svg>`
  );
}
