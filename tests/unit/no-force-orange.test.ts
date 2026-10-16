/**
 * Ruling D1016-ORANGE-1 (Ahmad 2026-10-16, "Ebda do not have orange"): Ebda's palette is night
 * #0A0B0C, gold #B08D57 and lift #CBA873 (`BRAND.colors`, packages/shared/src/brand). The Force AI
 * orange this repo inherited (#FF6F00 / #ff6e01 / #ff6e00, `26 100% 50%` and its tints, the
 * tailwind orange-500 brand fills, the `rgba(255,110,1,…)` glows) may not appear as a default,
 * fallback or chrome colour anywhere that runs: app and package source, CSS, tailwind configs,
 * public assets, seeds and scripts.
 *
 * NOT scanned: tests (they render merchant-PICKED orange on purpose, e.g. the K-02 contrast gate
 * feeds #FF6F00 as a merchant primary), docs (history), the AI eval fixture that describes a
 * merchant's orange logo. A merchant's own colour is data in the database, never a literal here.
 *
 * Semantic status hues (a warning chip's orange-50/100 tint with orange-700 ink) are not brand and
 * are not banned; a FILLED orange control (bg-orange-500/600, from-/to-/ring-orange-…) is.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BRAND,
  DEFAULT_THEME,
  hexToHsl,
  hslToHex,
  contrastRatio,
  deriveBrandRoles,
} from '@ebda/shared';

const ROOT = join(__dirname, '../..');

export const ORANGE: Array<[string, RegExp]> = [
  ['Force orange hex', /#(?:ff6f00|ff6e0[01]|f97316|fb923c|ea580c|ff7700)\b/i],
  [
    'orange HSL triplet (hue 20-35, saturation ≥ 90%)',
    /(?<![\d.])(?:2\d|3[0-5])(?:\.\d+)? (?:9\d|100)(?:\.\d+)?% \d/,
  ],
  ['Force orange rgb()', /rgba?\(\s*255\s*,\s*1[01]\d\s*,\s*[0-9]\s*[,)]/],
  ['filled tailwind orange', /\b(?:bg|from|via|to|ring|accent|fill|stroke)-orange-[3-6]00\b/],
  ['tailwind orange icon/text ink', /\btext-orange-[56]00\b/],
  ['orange hsl() with commas', /hsl\(\s*(?:2\d|3[0-5])(?:\.\d+)?\s*,\s*(?:9\d|100)%/],
  ['GL orange tint', /vec3\(\s*1\.0\s*,\s*0\.4\d*\s*,\s*0\.0\d*\s*\)/],
];

const SCAN_ROOTS = ['apps', 'packages', 'scripts'];
const TEXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|css|scss|json|html|svg|webmanifest)$/;
const SKIP = [
  /(^|\/)tests?\//,
  /(^|\/)__tests__\//,
  /\.(?:test|spec)\.[a-z]+$/,
  /(^|\/)node_modules\//,
  /package-lock\.json$/,
  /\.d\.ts$/,
];
/** Each entry: why this file may name an orange. Must still contain one (shrink-only). */
const ALLOW: Record<string, string> = {
  'apps/api/src/lib/ai/eval/fixtures/golden/store-content.ts':
    "an AI eval case: a MERCHANT's orange logo and the palette the model must extract from it",
};

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', ...SCAN_ROOTS], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(f => f && TEXT.test(f) && !SKIP.some(r => r.test(f)));
}

export function orangeHits(path: string, text: string): string[] {
  const out: string[] = [];
  text.split('\n').forEach((line, i) => {
    for (const [name, re] of ORANGE)
      if (re.test(line)) out.push(`${path}:${i + 1} ${name}: ${line.trim().slice(0, 120)}`);
  });
  return out;
}

describe('no Force orange anywhere that runs (Ruling D1016-ORANGE-1)', () => {
  const files = trackedFiles();

  it('scans the whole tree', () => {
    expect(files.length).toBeGreaterThan(1000);
  });

  it('no orange literal outside the allowlist', () => {
    const hits = files
      .filter(f => !(f in ALLOW))
      .flatMap(f => orangeHits(f, readFileSync(join(ROOT, f), 'utf8')));
    expect(hits).toEqual([]);
  });

  it('every allowlisted file still carries its orange (the list can only shrink)', () => {
    for (const f of Object.keys(ALLOW))
      expect(orangeHits(f, readFileSync(join(ROOT, f), 'utf8')).length, f).toBeGreaterThan(0);
  });

  it('the matcher catches the inherited shapes and leaves Ebda gold and status hues alone', () => {
    const hit = (s: string) => orangeHits('x', s).length > 0;
    for (const s of [
      "primaryColor: '26 100% 50%'",
      '--primary: 26 100% 55%;',
      '--accent: 30 100% 97%;',
      "particleColor = '#ff6e01'",
      "themeColor: '#f97316'",
      'shadow-[0_8px_40px_rgba(255,110,1,0.15)]',
      'className="bg-orange-500 hover:bg-orange-600"',
      'from-amber-500 to-orange-500',
      "if (!hslComponents) return 'hsl(26, 100%, 50%)';",
      'vec3 tint = vec3(1.0, 0.45, 0.06);',
    ])
      expect(hit(s), s).toBe(true);
    for (const s of [
      '--primary: 36.4 36.03% 51.57%;',
      "primaryColor: '210 9% 4%'",
      '--warning: 38 92% 50%;',
      '--warning: 43 96% 50%;',
      'bg-orange-50 text-orange-700',
      'dark:bg-orange-900/30',
      "'Vodafone Cash, Orange Cash, e& money'",
      '#B08D57',
    ])
      expect(hit(s), s).toBe(false);
  });
});

describe('the default store theme is Ebda night + gold, at AA (Ruling D1016-ORANGE-1)', () => {
  const hex = (t: string | undefined) => hslToHex(String(t));
  it('primary is night, ring is gold', () => {
    expect(DEFAULT_THEME.primaryColor).toBe(hexToHsl(BRAND.colors.night));
    expect(DEFAULT_THEME.ringColor).toBe(hexToHsl(BRAND.colors.gold));
  });
  it('the primary ink reads ≥ 4.5:1 (stored and derived agree)', () => {
    const derived = deriveBrandRoles(DEFAULT_THEME)['--primary-foreground'];
    expect(derived).toBe(DEFAULT_THEME.primaryForeground);
    expect(
      contrastRatio(hex(DEFAULT_THEME.primaryColor), hex(DEFAULT_THEME.primaryForeground))
    ).toBeGreaterThanOrEqual(4.5);
  });
  it('the accent pair reads ≥ 4.5:1 and the gold ring ≥ 3:1 on the page', () => {
    expect(
      contrastRatio(hex(DEFAULT_THEME.accentColor), hex(DEFAULT_THEME.accentForeground))
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(hex(DEFAULT_THEME.ringColor), hex(DEFAULT_THEME.backgroundColor))
    ).toBeGreaterThanOrEqual(3);
  });
});
