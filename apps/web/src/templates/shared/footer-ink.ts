import type { CSSProperties } from 'react';
import { contrastRatio, parseColorToRgb, rgbToHslTriplet } from '@ebda/shared';

/**
 * Footer ink derived from the footer's OWN paint (B0-46 review I-1).
 *
 * A merchant `bgColor` can be any colour; every skin's text uses theme tokens
 * (text-foreground, text-muted-foreground, text-foreground/70 ...) that are only
 * guaranteed readable on the skin's default footer background. When the merchant
 * paints the footer, the footer root re-scopes those tokens to an ink picked against
 * that paint, so links, copyright, legal row, WhatsApp, newsletter and the brand name
 * all clear WCAG AA (4.5:1) together. The alpha-style classes are neutralised in
 * globals.css (`[data-footer-ink]` rules) by pointing them at the solid muted ink.
 *
 * `bgColor` reaches the footer already resolved (ShopChrome runs `resolveColor`, so a
 * `token:*` is a real colour by then). A gradient is resolved to its stops and judged
 * on the WORST stop. Alpha in an 8-digit hex is ignored (the page paints under it and
 * is not knowable here). An unparseable paint yields no override (tokens stay).
 */

const STOP_RE = /#[0-9a-f]{8}\b|#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|hsla?\([^)]*\)|rgba?\([^)]*\)/gi;

function parseStop(raw: string): { r: number; g: number; b: number } | null {
  const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)/i.exec(raw);
  if (rgb) return { r: +rgb[1], g: +rgb[2], b: +rgb[3] };
  const hsla = /^hsla?\(([^)]*)\)/i.exec(raw);
  // parseColorToRgb takes `hsl(H S% L%)`; strip any alpha part first.
  const norm = hsla ? `hsl(${hsla[1].split('/')[0].replace(/,\s*[\d.]+\s*$/, '')})` : raw;
  return parseColorToRgb(norm);
}

const hex = (c: { r: number; g: number; b: number }) =>
  '#' +
  [c.r, c.g, c.b]
    .map(v =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('');

/** Every colour stop of a paint (solid or gradient), as RGB; empty when unparseable. */
export function parseBgStops(bg: string | undefined): { r: number; g: number; b: number }[] {
  if (!bg) return [];
  return (bg.match(STOP_RE) ?? [])
    .map(parseStop)
    .filter((c): c is { r: number; g: number; b: number } => c !== null);
}

export interface FooterInk {
  fg: '#ffffff' | '#000000';
  /** Solid colour (no alpha) for muted text, >= 4.5:1 on every stop. */
  muted: string;
}

export function resolveFooterInk(bg: string | undefined): FooterInk | undefined {
  if (!bg) return undefined;
  const stops = (bg.match(STOP_RE) ?? [])
    .map(parseStop)
    .filter((c): c is { r: number; g: number; b: number } => c !== null);
  if (stops.length === 0) return undefined;
  const worst = (fg: string) => Math.min(...stops.map(s => contrastRatio(hex(s), fg)));
  const fg = worst('#ffffff') >= worst('#000000') ? '#ffffff' : '#000000';
  const fgRgb = parseColorToRgb(fg)!;
  // The stop the ink sits worst on: muted is blended over it, then re-checked on all stops.
  const anchor = stops.reduce((a, s) =>
    contrastRatio(hex(s), fg) < contrastRatio(hex(a), fg) ? s : a
  );
  for (const alpha of [0.78, 0.86, 0.94, 1]) {
    const muted = hex({
      r: fgRgb.r * alpha + anchor.r * (1 - alpha),
      g: fgRgb.g * alpha + anchor.g * (1 - alpha),
      b: fgRgb.b * alpha + anchor.b * (1 - alpha),
    });
    if (Math.min(...stops.map(s => contrastRatio(hex(s), muted))) >= 4.6) return { fg, muted };
  }
  return { fg, muted: fg };
}

const triplet = (c: string) => rgbToHslTriplet(parseColorToRgb(c)!);

/** Props to spread on the footer root: paint + (when the paint is merchant-set) the ink. */
export function footerRootPaint(bgColor: string | undefined): {
  style: CSSProperties | undefined;
  'data-footer-ink'?: '';
} {
  if (!bgColor) return { style: undefined };
  const ink = resolveFooterInk(bgColor);
  if (!ink) return { style: { backgroundColor: bgColor } };
  const opposite = ink.fg === '#ffffff' ? '#000000' : '#ffffff';
  return {
    'data-footer-ink': '',
    style: {
      backgroundColor: bgColor,
      color: ink.fg,
      '--foreground': triplet(ink.fg),
      '--background': triplet(opposite),
      '--muted-foreground': triplet(ink.muted),
      '--footer-ink': ink.fg,
      '--footer-ink-muted': ink.muted,
    } as CSSProperties,
  };
}
