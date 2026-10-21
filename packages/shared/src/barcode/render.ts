import { code128Modules } from './code128';
import { barcodeShapeData } from './shapes';

export interface RenderBarcodeOptions {
  value: string;
  /** `plain` or a shape id; anything unknown renders plain. */
  shape?: string;
  /** Show the human-readable number under the bars (default true). */
  label?: boolean;
  /** Bar colour. Default `currentColor` so the page's ink token decides. */
  ink?: string;
}

const PAD = 12; // breathing room around the shape
const ZONE = 48; // scan-zone height in shape units
const QUIET = 10; // Code 128 quiet zone, in modules
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
export function renderBarcodeSvg({ value, shape = 'plain', label = true, ink = 'currentColor' }: RenderBarcodeOptions): string {
  const mods = code128Modules(value);
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
  const id = `bcm-${shape}`;
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
