/**
 * Ruling D1016-ORANGE-1 (Ahmad 2026-10-16, "Ebda do not have orange"): Ebda's palette is night
 * #0A0B0C, gold #B08D57 and lift #CBA873 (`BRAND.colors`, packages/shared/src/brand). The inherited
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

/**
 * Hue-based (review I5): every colour literal in code is parsed — hex (#rgb/#rgba/#rrggbb/
 * #rrggbbaa), rgb()/rgba(), hsl()/hsla(), bare HSL triplets ("26 100% 50%", the StoreTheme and
 * CSS-variable form) and oklch() — and refused when it falls in the saturated orange band:
 * hue 15–34°, saturation ≥ 85%, lightness 30–97% (the pale peach tints of the old chrome too). Six exact codes let `#fc6b02` (19 admin lines)
 * through. Status ambers (hue ≥ 36: warning 38°, amber-500 37.7°) and reds stay allowed.
 */
export const ORANGE_BAND = { hueMin: 15, hueMax: 34, satMin: 85, lightMin: 30, lightMax: 97 };

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l * 100];
  const sat = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, sat * 100, l * 100];
}

function oklchToRgb(L: number, C: number, H: number): [number, number, number] {
  const hr = (H * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);
  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  const enc = (x: number) =>
    Math.round(
      255 * Math.min(1, Math.max(0, x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055))
    );
  return [enc(lin[0]), enc(lin[1]), enc(lin[2])];
}

/** Every colour literal on a line, as [source text, h, s, l]. */
export function colourLiterals(line: string): Array<[string, number, number, number]> {
  const out: Array<[string, number, number, number]> = [];
  for (const m of line.matchAll(/#([0-9a-fA-F]{3,8})(?![0-9a-zA-Z_-])/g)) {
    const hex = m[1];
    if (![3, 4, 6, 8].includes(hex.length)) continue;
    if (/^\d+$/.test(hex) && hex.length <= 4) continue; // an issue number like #1609, not a colour
    const full = hex.length <= 4 ? [...hex.slice(0, 3)].map(c => c + c).join('') : hex.slice(0, 6);
    const n = parseInt(full, 16);
    out.push([m[0], ...rgbToHsl((n >> 16) & 255, (n >> 8) & 255, n & 255)]);
  }
  for (const m of line.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/g))
    out.push([m[0], ...rgbToHsl(+m[1], +m[2], +m[3])]);
  for (const m of line.matchAll(/hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/g))
    out.push([m[0], +m[1], +m[2], +m[3]]);
  for (const m of line.matchAll(/(?<![\d.\w(,])([\d.]+) ([\d.]+)% ([\d.]+)%/g))
    out.push([m[0], +m[1], +m[2], +m[3]]);
  for (const m of line.matchAll(/oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)/g)) {
    const L = m[2] ? +m[1] / 100 : +m[1];
    out.push([m[0], ...rgbToHsl(...oklchToRgb(L, +m[3], +m[4]))]);
  }
  return out;
}

export function isOrange([, h, s, l]: [string, number, number, number]): boolean {
  const B = ORANGE_BAND;
  return h >= B.hueMin && h <= B.hueMax && s >= B.satMin && l >= B.lightMin && l <= B.lightMax;
}

export const ORANGE: Array<[string, RegExp]> = [
  ['filled tailwind orange', /\b(?:bg|from|via|to|ring|accent|fill|stroke)-orange-[3-6]00\b/],
  ['tailwind orange icon/text ink', /\btext-orange-[56]00\b/],
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
  'apps/web/src/templates/shared/icons.tsx':
    "Instagram's official logo gradient (#FB8A2E stop): a third-party brand mark, not Ebda chrome",
  'apps/admin/public/provider-logos/geidea.svg':
    "Geidea's official logo (#FF4D00): a third-party brand mark shown unaltered, not Ebda chrome",
  'apps/admin/src/app/stores/[id]/branding/_components/types.ts':
    "COLOR_PRESETS: the merchant's own swatch choices (an orange option a merchant may pick), not a default",
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
    for (const c of colourLiterals(line))
      if (isOrange(c))
        out.push(
          `${path}:${i + 1} orange ${c[0]} (h${c[1].toFixed(0)} s${c[2].toFixed(0)} l${c[3].toFixed(0)}): ${line.trim().slice(0, 100)}`
        );
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
      "className='bg-[#fc6b02] text-white'",
      'accent-[#FC6B02]',
      'color: rgb(252, 107, 2)',
      'background: oklch(0.7 0.19 45)',
      'fill="#f60"',
      '#ff6e01cc',
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
      '#F79E1B', // Mastercard's own amber, hue 36
      '#EB001B',
      '#f59e0b', // amber-500 (status), hue 38
      'see issue #1609 and #2092',
      'oklch(0.7 0.15 250)',
    ])
      expect(hit(s), s).toBe(false);
  });
});

/**
 * K-02 for code (review N1): a primary FILL takes the primary's on-token ink, never white. White on
 * the admin gold is 3.07:1. A fill is `bg-primary` at full or ≥80% alpha, or a gradient that STARTS
 * at full or ≥80% primary (`from-primary`, `from-primary/80`, `from-primary/90`); a /10 tint is not
 * a fill. Scans the admin, the storefront and @ebda/ui.
 */
export function primaryFillWithWhite(classes: string): boolean {
  const fill = /(?<![\w:/-])(?:bg|from)-primary(?:\/(\d+))?(?![\w/-])/g;
  let isFill = false;
  for (const m of classes.matchAll(fill)) if (!m[1] || Number(m[1]) >= 80) isFill = true;
  return isFill && /(?<![\w:/-])text-white(?![\w/-])/.test(classes);
}

describe('a primary fill takes the primary ink, never white (K-02, admin + storefront)', () => {
  it('the matcher (self-test)', () => {
    for (const c of [
      'bg-primary text-white',
      'bg-gradient-to-br from-primary to-primary/90 text-white',
      'from-primary/80 to-primary text-white',
      'bg-primary/90 text-white',
    ])
      expect(primaryFillWithWhite(c), c).toBe(true);
    for (const c of [
      'bg-primary text-primary-foreground',
      'from-primary/10 to-primary/10 text-white',
      'bg-primary/10 text-white',
      'hover:bg-primary text-white',
      'bg-black text-white',
    ])
      expect(primaryFillWithWhite(c), c).toBe(false);
  });

  it('no class string pairs a primary fill with text-white', () => {
    const scan = trackedFiles().filter(
      f => /^(apps\/admin\/src|apps\/web\/src|packages\/ui\/src)\//.test(f) && /\.tsx?$/.test(f)
    );
    const bad: string[] = [];
    for (const f of scan) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      for (const m of src.matchAll(/["'`][^"'`\n]*["'`]/g))
        if (primaryFillWithWhite(m[0])) bad.push(`${f}: ${m[0].slice(0, 90)}`);
    }
    expect(bad).toEqual([]);
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
