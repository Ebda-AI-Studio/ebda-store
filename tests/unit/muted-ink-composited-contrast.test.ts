/**
 * K-03 / K-04 (Qamar taste audit 2026-10-15, quality-bar § 3): muted text is
 * measured as the COMPOSITED colour, alpha included.
 *  - K-03: the receipt's `.inkMuted` (variant + personalisation lines) was
 *    rgb(20 20 20 / 0.55) on the white paper = 4.06:1. Every ink class on the
 *    paper must composite to >= 4.5:1.
 *  - K-04: the menu drawer heading was `text-foreground/50` = 3.45:1. Foreground
 *    at 60% still fails on 13 of the 30 look page/surface pairs (measured
 *    2026-10-16; 70% passes all 30), so `text-foreground/<70` is banned on the
 *    storefront: muted text uses `text-muted-foreground`, or an alpha >= 70,
 *    proven below on the default palette and every look.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { LOOKS, contrastRatio, parseColorToRgb } from '@ebda/shared';

const ROOT = join(__dirname, '../..');
const WEB = join(ROOT, 'apps/web/src');

type Rgb = { r: number; g: number; b: number };
const hex = ({ r, g, b }: Rgb) =>
  '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
/** `fg` at `alpha` painted over the opaque `bg`. */
export function composite(fg: string, alpha: number, bg: string): string {
  const f = parseColorToRgb(fg)!;
  const b = parseColorToRgb(bg)!;
  return hex({
    r: f.r * alpha + b.r * (1 - alpha),
    g: f.g * alpha + b.g * (1 - alpha),
    b: f.b * alpha + b.b * (1 - alpha),
  });
}

describe('K-03: every receipt ink composites to >= 4.5:1 on the paper', () => {
  const css = readFileSync(join(WEB, 'components/commerce/ReceiptPrinter.module.css'), 'utf8');
  const paperBg = css.match(/\.paper\s*{[^}]*background:\s*(#[0-9a-f]{3,6})/i)![1];
  const inks = [...css.matchAll(/\.(ink\w*)\s*{\s*color:\s*([^;]+);/g)].map(m => ({
    name: m[1],
    value: m[2].trim(),
  }));

  it('reads the paper and its ink classes', () => {
    expect(paperBg.toLowerCase()).toBe('#ffffff');
    expect(inks.map(i => i.name)).toEqual(expect.arrayContaining(['ink', 'inkMuted', 'inkSoft']));
  });

  for (const ink of [
    { name: 'ink', value: '' },
    { name: 'inkMuted', value: '' },
    { name: 'inkSoft', value: '' },
  ])
    it(`.${ink.name} >= 4.5:1`, () => {
      const v = inks.find(i => i.name === ink.name)!.value;
      const rgba = v.match(/^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\s*\)$/);
      const painted = rgba
        ? composite(
            `#${[rgba[1], rgba[2], rgba[3]].map(n => (+n).toString(16).padStart(2, '0')).join('')}`,
            +rgba[4],
            paperBg
          )
        : v;
      expect(contrastRatio(paperBg, painted)).toBeGreaterThanOrEqual(4.5);
    });
});

describe('K-04: foreground text never drops under 70% alpha', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap(n => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return walk(p);
      return /\.(tsx|ts|css)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
    });
  const LOW = /(?:^|[\s'"`:])text-foreground\/(?:[1-6]\d|\d)(?![\d.])/;

  it('no storefront element sets text-foreground under /70', () => {
    const hits = walk(WEB).flatMap(f =>
      readFileSync(f, 'utf8')
        .split('\n')
        .flatMap((l, i) => (LOW.test(l) ? [`${relative(ROOT, f)}:${i + 1}: ${l.trim()}`] : []))
    );
    expect(hits).toEqual([]);
  });

  it('the matcher catches the old shapes (self-test)', () => {
    expect(LOW.test('"text-xs uppercase text-foreground/50"')).toBe(true);
    expect(LOW.test("'w-4 text-foreground/55'")).toBe(true);
    expect(LOW.test(' placeholder:text-foreground/40 ')).toBe(true);
    expect(LOW.test(' text-foreground/5 ')).toBe(true);
    expect(LOW.test(' text-foreground/60 ')).toBe(true);
    expect(LOW.test(' text-foreground/70 ')).toBe(false);
    expect(LOW.test(' text-foreground/75 ')).toBe(false);
    expect(LOW.test(' text-muted-foreground ')).toBe(false);
  });

  it('the /70 floor holds on the default palette and on every look (page + surface)', () => {
    const css = readFileSync(join(WEB, 'styles/globals.css'), 'utf8');
    const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
    const v = (n: string) => `hsl(${root.match(new RegExp(`--${n}:\\s*([^;]+);`))![1].trim()})`;
    const pairs: Array<[string, string, string]> = [
      ['default', v('foreground'), v('background')],
      ...LOOKS.flatMap(l => [
        [`${l.id} page`, l.tokens.ink, l.tokens.page] as [string, string, string],
        [`${l.id} surface`, l.tokens.ink, l.tokens.surface] as [string, string, string],
      ]),
    ];
    const fails = pairs
      .map(([name, fg, bg]) => [name, contrastRatio(bg, composite(fg, 0.7, bg))] as const)
      .filter(([, r]) => r < 4.5);
    expect(fails).toEqual([]);
  });
});
