import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GirihPoster, WindowGirih } from '../../apps/marketing/src/components/GirihPoster';

/**
 * Ruling MKT-NO-HEXAGRAM-1 (Ahmad 2026-11-03): no {6/2} star (two overlapping triangles, which reads as the Star of David) may be drawn
 * by any marketing motif, pattern generator or SVG. The Chat family is the 12-point star; the Store family is the 8-fold Rub el Hizb.
 * Three guards: (1) every closed polygon in the motif SVGs and in the rendered poster is not a 6-tip star, (2) no two triangles share a
 * centre, (3) no source file asks for a 6-tip star. The detector has a negative control so a dead guard cannot pass.
 */
const ROOT = path.resolve(__dirname, '../..');
const MARKETING = path.join(ROOT, 'apps/marketing');
type Pt = [number, number];

/** Closed M/L/Z subpaths of an SVG path `d` (the only commands the star generators emit). */
function polygons(d: string): Pt[][] {
  const out: Pt[][] = [];
  for (const sub of d.split(/(?=M)/)) {
    if (!/Z\s*$/i.test(sub.trim())) continue;
    const nums = [...sub.matchAll(/-?\d*\.?\d+/g)].map(m => Number(m[0]));
    const pts: Pt[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
    if (pts.length >= 3) out.push(pts);
  }
  return out;
}
const centroid = (p: Pt[]): Pt => [
  p.reduce((a, q) => a + q[0], 0) / p.length,
  p.reduce((a, q) => a + q[1], 0) / p.length,
];
/** A 12-vertex polygon whose alternating radii are two constant values (ratio 0.5-0.65) at 30 degree steps is a {6/2}-like 6-tip star. */
function isSixTipStar(p: Pt[]): boolean {
  if (p.length !== 12) return false;
  const [cx, cy] = centroid(p);
  const r = p.map(([x, y]) => Math.hypot(x - cx, y - cy));
  const even = r.filter((_, i) => i % 2 === 0);
  const odd = r.filter((_, i) => i % 2 === 1);
  const flat = (a: number[]) => Math.max(...a) - Math.min(...a) < 0.04 * Math.max(...a);
  if (!flat(even) || !flat(odd)) return false;
  const ratio = Math.min(even[0], odd[0]) / Math.max(even[0], odd[0]);
  return ratio > 0.5 && ratio < 0.65;
}
function twoTriangles(polys: Pt[][]): boolean {
  const tri = polys.filter(p => p.length === 3).map(centroid);
  return tri.some((a, i) => tri.some((b, j) => j > i && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1));
}
function offenders(svgish: string): string[] {
  const polys = [
    ...svgish.matchAll(/\bd="([^"]+)"/g),
    ...svgish.matchAll(/\bd='([^']+)'/g),
  ].flatMap(m => polygons(m[1]));
  const bad = polys.filter(isSixTipStar).map(() => '6-tip star polygon');
  if (twoTriangles(polys)) bad.push('two triangles sharing a centre');
  return bad;
}

const motifDir = path.join(MARKETING, 'public/motifs');
const files = readdirSync(motifDir).filter(f => f.endsWith('.svg'));

describe('MKT-NO-HEXAGRAM-1: no two-triangle star in any marketing motif', () => {
  it('negative control: the detector flags a real hexagram and passes a 12-point star', () => {
    const hex = (n: number, ri: number) =>
      'M' +
      Array.from({ length: n * 2 }, (_, k) => {
        const a = (k * Math.PI) / n;
        const r = k % 2 ? ri : 10;
        return `${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`;
      }).join('L') +
      'Z';
    expect(offenders(`<path d="${hex(6, 5.77)}"/>`)).not.toEqual([]);
    expect(offenders(`<path d="${hex(12, 6.8)}"/>`)).toEqual([]);
    expect(
      offenders(`<path d="M0 -10L8.66 5L-8.66 5Z"/><path d="M0 10L8.66 -5L-8.66 -5Z"/>`)
    ).toContain('two triangles sharing a centre');
  });

  it('there are motif files to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)('public/motifs/%s draws no hexagram', f => {
    expect(offenders(readFileSync(path.join(motifDir, f), 'utf8'))).toEqual([]);
  });

  it('the rendered poster patterns draw no hexagram', () => {
    const html =
      renderToStaticMarkup(createElement(GirihPoster)) +
      renderToStaticMarkup(createElement(WindowGirih, { id: 'g12w' })) +
      renderToStaticMarkup(createElement(WindowGirih, { id: 'g8w' }));
    expect(html).toContain('<pattern');
    expect(offenders(html)).toEqual([]);
  });

  it('no source file asks a generator for a 6-tip star', () => {
    const src = [
      'apps/marketing/public/studio-pattern.js',
      'apps/marketing/src/components/GirihPoster.tsx',
      'apps/marketing/src/components/StudioHome.tsx',
      'apps/marketing/src/app/motifs.css',
    ];
    for (const rel of src) {
      const t = readFileSync(path.join(ROOT, rel), 'utf8');
      expect(t, rel).not.toMatch(/\bstar\s*\(\s*[^,()]+,\s*[^,()]+,\s*6\s*,/); // star(x, y, 6, ...)
      expect(t, rel).not.toMatch(/\b(star6|inner6|P6)\b|(?<!NO-)hexagram|\/(m6|d6|strip6|tess6)/i);
      expect(t, rel).not.toMatch(/data-win="6"/);
    }
  });
});
