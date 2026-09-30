/**
 * Issue 2349, storefront half (owner option A, 2026-09-30): status-message
 * text on the storefront (warning / info / success / error banners, pills and
 * inline messages) uses `text-<role>-ink`. Each store's inks are derived from
 * ITS palette by `statusInkVars` and emitted with the theme, so they are gated
 * here per palette — the five template themes, the platform default, and
 * palettes built to break a naive derivation — on every surface the text sits
 * on, bare and under every tint up to 30%, at WCAG AA (4.5:1).
 *
 * A store whose theme sets `legacyBannerContrast: true` (pecannbee, pinned by
 * data — Ruling BC-1) gets `--<role>-ink: var(--<role>)`, i.e. the ink IS the
 * role colour and the text renders exactly as before. That pass-through must
 * survive every emitter: the shared themeToCssVars, the SSR style tag
 * sanitizer, the client StoreContext mirror, and the per-page surface wrapper.
 *
 * Contrast is re-computed here independently (floating point, no rounding)
 * rather than through the helpers under test.
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME,
  getTemplateTheme,
  themeToCssVars,
  statusInkVars,
  STATUS_INK_ROLES,
  type StoreTheme,
  type TemplateId,
} from '@force/shared';
import { buildThemeStyleTag } from '@web/lib/theme-css';
import { pageSurfaceStyle } from '@web/lib/page-surface';

const REPO = resolve(__dirname, '../..');
const TINTS = [0, 0.05, 0.1, 0.15, 0.2, 0.3];

function rgb(triplet: string): number[] {
  const m = /^(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(triplet.trim());
  if (!m) throw new Error(`not a triplet: ${triplet}`);
  const [h, S, L] = [Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100];
  const k = (n: number) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map(x => x * 255);
}
const lum = (c: number[]) => {
  const [r, g, b] = c.map(v => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: number[], b: number[]) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** Worst contrast of `ink` over the role's tints on every surface. */
function worst(ink: string, role: string, surfaces: string[]): number {
  let min = Infinity;
  for (const s of surfaces)
    for (const a of TINTS) {
      const bg = rgb(role).map((v, i) => v * a + rgb(s)[i] * (1 - a));
      min = Math.min(min, ratio(rgb(ink), bg));
    }
  return min;
}
const INFO = '199 89% 48%'; // not a theme field: the storefront default

const TEMPLATES: TemplateId[] = ['modern', 'elegant', 'classic', 'minimal', 'bold'];
const HOSTILE: Array<[string, Partial<StoreTheme>]> = [
  // A pale warning on a cream card: the bare role reads ~1.3:1.
  ['pale warning on cream', { warningColor: '50 100% 70%', cardColor: '40 60% 95%' }],
  // A dark store: the ink must go LIGHTER, not darker.
  [
    'dark card and page',
    {
      cardColor: '220 20% 10%',
      backgroundColor: '220 20% 7%',
      successColor: '142 60% 30%',
      destructiveColor: '0 70% 35%',
    },
  ],
  // A role saved as hex (older editor) and a token reference.
  ['hex + token roles', { destructiveColor: '#e11d48', successColor: 'token:primary' }],
  ['warm-sand page rhythm', { backgroundPreset: 'warmSand' }],
];

const PALETTES: Array<[string, StoreTheme]> = [
  ['platform default', DEFAULT_THEME],
  ...TEMPLATES.map(t => [`template ${t}`, getTemplateTheme(t)] as [string, StoreTheme]),
  ...HOSTILE.map(
    ([name, o]) =>
      [`hostile: ${name}`, { ...DEFAULT_THEME, ...o } as StoreTheme] as [string, StoreTheme]
  ),
];

describe('per-store inks read at >= 4.5:1 (default, issue 2349)', () => {
  for (const [name, theme] of PALETTES) {
    it.each(STATUS_INK_ROLES)(`${name}: %s-ink on card, page and every tint`, role => {
      const v = themeToCssVars(theme);
      // Messages sit on the page background or a card (never on the homepage
      // section-rhythm tokens, which stay white on a dark store).
      const surfaces = [v['--card'], v['--background']];
      const roleColor = role === 'info' ? INFO : v[`--${role}`];
      expect(worst(v[`--${role}-ink`], roleColor, surfaces)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('control: the bare role colour really fails where the ink passes', () => {
    const v = themeToCssVars(DEFAULT_THEME);
    const surfaces = [v['--card'], v['--background']];
    expect(worst(v['--warning'], v['--warning'], surfaces)).toBeLessThan(3);
    expect(worst(v['--destructive'], v['--destructive'], surfaces)).toBeLessThan(4.5);
  });

  it('keeps the role hue (a darker amber, not a new colour)', () => {
    const v = themeToCssVars(DEFAULT_THEME);
    for (const role of ['success', 'warning', 'destructive'] as const)
      expect(v[`--${role}-ink`].split(' ')[0]).toBe(v[`--${role}`].split(' ')[0]);
  });

  it('a dark store gets a LIGHTER ink than its role colour', () => {
    const v = themeToCssVars({ ...DEFAULT_THEME, ...HOSTILE[1][1] } as StoreTheme);
    const l = (t: string) => Number(t.split(' ')[2].replace('%', ''));
    expect(l(v['--destructive-ink'])).toBeGreaterThan(l(v['--destructive']));
  });
});

describe('legacyBannerContrast: the ink is the role colour (pecannbee, Ruling BC-1)', () => {
  const legacy = { ...DEFAULT_THEME, legacyBannerContrast: true } as StoreTheme;

  it('themeToCssVars emits var(--<role>) for every ink', () => {
    const v = themeToCssVars(legacy);
    for (const role of STATUS_INK_ROLES) expect(v[`--${role}-ink`]).toBe(`var(--${role})`);
  });

  it('the flag changes ONLY the ink vars', () => {
    const on = themeToCssVars(legacy);
    const off = themeToCssVars(DEFAULT_THEME);
    const diff = Object.keys({ ...on, ...off }).filter(k => on[k] !== off[k]);
    expect(diff.sort()).toEqual(STATUS_INK_ROLES.map(r => `--${r}-ink`).sort());
  });

  it('the SSR style tag keeps the pass-through (the sanitizer must not blacken it)', () => {
    const tag = buildThemeStyleTag(legacy);
    for (const role of STATUS_INK_ROLES) expect(tag).toContain(`--${role}-ink: var(--${role})`);
    expect(tag).not.toMatch(/-ink: 0 0% 0%/);
  });

  it('the sanitizer allows ONLY the exact pass-through on an ink key', () => {
    const evil = { ...DEFAULT_THEME, warningColor: 'var(--x)); } body { color: red' } as StoreTheme;
    expect(buildThemeStyleTag(evil)).not.toContain('body {');
    // A var() on a non-ink key still falls back.
    expect(
      buildThemeStyleTag({ ...DEFAULT_THEME, primaryColor: 'var(--success)' } as StoreTheme)
    ).toContain('--primary: 0 0% 0%');
  });

  it('statusInkVars ignores the palette entirely when legacy', () => {
    expect(statusInkVars({ warning: '50 100% 70%' }, ['0 0% 100%'], true)).toEqual({
      '--success-ink': 'var(--success)',
      '--warning-ink': 'var(--warning)',
      '--info-ink': 'var(--info)',
      '--destructive-ink': 'var(--destructive)',
    });
  });

  it('the client StoreContext mirror emits the same inks from the same inputs', () => {
    const src = readFileSync(join(REPO, 'apps/web/src/contexts/StoreContext.tsx'), 'utf8');
    const shared = readFileSync(join(REPO, 'packages/shared/src/types/store-theme.ts'), 'utf8');
    const call = (s: string) =>
      /statusInkVars\(([\s\S]*?theme\.legacyBannerContrast === true\s*)\)/
        .exec(s)?.[1]
        .replace(/\s+/g, ' ');
    expect(call(src)).toBeTruthy();
    expect(call(src)).toBe(call(shared));
  });
});

describe('page surface wrapper (merchant page colour on cart / checkout / PDP / PLP)', () => {
  it('a dark page gets its own, lighter inks that read on the wrapper surfaces', () => {
    const style = pageSurfaceStyle('#1a1a1a', DEFAULT_THEME, 'auto') as Record<string, string>;
    const surfaces = [style['--background'], style['--card']];
    for (const role of STATUS_INK_ROLES) {
      const roleColor = role === 'info' ? INFO : themeToCssVars(DEFAULT_THEME)[`--${role}`];
      expect(worst(style[`--${role}-ink`], roleColor, surfaces), role).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('a light page colour gets inks measured on it and on the card', () => {
    const style = pageSurfaceStyle('#f5ecd7', DEFAULT_THEME, 'auto') as Record<string, string>;
    expect(style['--warning-ink']).toBeDefined();
    const v = themeToCssVars(DEFAULT_THEME);
    expect(
      worst(style['--warning-ink'], v['--warning'], ['40 63% 90%', v['--card']])
    ).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['#1a1a1a', '#f5ecd7'])(
    'legacy: page %s sets no ink (it inherits the root pass-through, as before)',
    bg => {
      const legacy = { ...DEFAULT_THEME, legacyBannerContrast: true } as StoreTheme;
      const style = pageSurfaceStyle(bg, legacy, 'auto') as Record<string, string>;
      expect(Object.keys(style).filter(k => k.endsWith('-ink'))).toEqual([]);
    }
  );
});

describe('no slug branching (Ruling BC-1: pecannbee is pinned by data)', () => {
  it.each([
    'packages/shared/src/utils/status-ink.ts',
    'apps/web/src/lib/page-surface.ts',
    'apps/web/src/lib/theme-css.ts',
    'apps/web/src/contexts/StoreContext.tsx',
  ])('%s never branches on a store', file => {
    const src = readFileSync(join(REPO, file), 'utf8');
    expect(src).not.toMatch(/['"`](pecannbee|wadyaljuz|palora)['"`]/i);
    expect(src).not.toMatch(/\.slug\s*[!=]==/);
  });
});
