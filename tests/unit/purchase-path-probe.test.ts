/**
 * Quality bar § 10 rule (d) + contrast, on RENDERED pages (W5). The W4 gate read Tailwind
 * classes in jsdom and passed while seven cart and checkout controls measured 16-32px in the
 * browser (independent a11y re-audit P1-N2..N4). scripts/taste/purchase-path-probe.mjs measures
 * hit boxes and composited contrast inside every manifest screen the shoot visits; this file pins
 * its math and, given a shoot's probe files, fails on any violation.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  hitBox,
  parseCssColor,
  composite,
  contrast,
  minContrastFor,
  MIN_TARGET,
} from '../../scripts/taste/purchase-path-probe.mjs';

describe('probe math', () => {
  it('a ::before with negative absolute insets grows the hit box; anything else does not', () => {
    const r = { width: 20, height: 20 };
    expect(
      hitBox(r, { position: 'absolute', top: -12, bottom: -12, left: -12, right: -12 })
    ).toEqual({
      w: 44,
      h: 44,
    });
    expect(hitBox(r, { position: 'static', top: -12 })).toEqual({ w: 20, h: 20 });
    expect(hitBox(r, { position: 'absolute', top: 4, left: undefined })).toEqual({ w: 20, h: 20 });
    expect(MIN_TARGET).toBe(44);
  });
  it('reads rgb, rgba and color(srgb) and composites alpha', () => {
    expect(parseCssColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseCssColor('rgba(0, 0, 0, 0.5)')!.a).toBe(0.5);
    expect(parseCssColor('color(srgb 1 0 0 / 0.25)')).toEqual({ r: 255, g: 0, b: 0, a: 0.25 });
    const mid = composite({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 });
    expect(Math.round(mid.r)).toBe(128);
  });
  it('contrast and the large-text threshold follow WCAG', () => {
    const black = { r: 0, g: 0, b: 0, a: 1 };
    const white = { r: 255, g: 255, b: 255, a: 1 };
    expect(contrast(black, white)).toBeCloseTo(21, 0);
    expect(minContrastFor(16, 400)).toBe(4.5);
    expect(minContrastFor(19, 700)).toBe(3);
    expect(minContrastFor(24, 400)).toBe(3);
  });
});

// PURCHASE_PATH_PROBE=<dir>:<prefix>[,<prefix>] after a shoot: zero violations on every screen.
const probe = process.env.PURCHASE_PATH_PROBE;
describe.skipIf(!probe)('rendered purchase path has no target or contrast violations', () => {
  const [dir, prefixes] = (probe ?? ':').split(':');
  for (const p of prefixes.split(',').filter(Boolean)) {
    it(p, () => {
      const f = path.join(dir, `${p}-probe.json`);
      expect(existsSync(f), f).toBe(true);
      const rows = JSON.parse(readFileSync(f, 'utf8')) as Array<{
        screen: string;
        viewport: string;
        targets: string[];
        lowContrast: string[];
      }>;
      const manifest = JSON.parse(
        readFileSync(path.join(__dirname, '../../docs/ebda/templates/purchase-path.json'), 'utf8')
      );
      expect(rows.length).toBe(manifest.screens.length * manifest.viewports.length);
      const bad = rows.flatMap(r => [
        ...r.targets.map(t => `${r.screen} ${r.viewport} target ${t}`),
        ...r.lowContrast.map(c => `${r.screen} ${r.viewport} contrast ${c}`),
      ]);
      expect(bad).toEqual([]);
    });
  }
});
