// tests/unit/looks-contrast.test.ts
import { describe, it, expect } from 'vitest';
import { LOOKS, contrastRatio } from '@ebda/shared';

const PAIRS: [string, (t: any) => [string, string]][] = [
  ['ink on page', t => [t.page, t.ink]],
  ['ink on surface', t => [t.surface, t.ink]],
  ['muted on page', t => [t.page, t.muted]],
  ['muted on surface', t => [t.surface, t.muted]],
  ['onPrimary on primary', t => [t.primary, t.onPrimary]],
  // A look with `onAccent` uses its accent as a fill only (VT-03); its pair is onAccent on accent.
  ['accent text on page', t => (t.onAccent ? [t.accent, t.onAccent] : [t.page, t.accent])],
];

function hexToOklchLC(hex: string): { L: number; C: number; h: number } {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

describe('every look meets AA', () => {
  for (const look of LOOKS)
    for (const [label, pick] of PAIRS)
      it(`${look.id}: ${label} ≥ 4.5`, () => {
        const [bg, fg] = pick(look.tokens);
        expect(contrastRatio(bg, fg)).toBeGreaterThanOrEqual(4.5);
      });
});

describe('no cream/sand page backgrounds', () => {
  for (const look of LOOKS)
    it(`${look.id} page is not in the cream band`, () => {
      const { L, C, h } = hexToOklchLC(look.tokens.page);
      const cream = L >= 0.84 && L <= 0.97 && C < 0.06 && h >= 40 && h <= 100;
      expect(cream).toBe(false);
    });
});
