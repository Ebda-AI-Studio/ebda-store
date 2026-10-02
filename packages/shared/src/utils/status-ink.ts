// packages/shared/src/utils/status-ink.ts
//
// Issue 2349 (storefront half, owner option A 2026-09-30). A status role on its
// own tint (`bg-warning/10 text-warning`) or bare on the card is unreadable:
// amber on amber measured 1.98:1, red on red 3.30:1. Storefront message text
// uses `text-<role>-ink`, and this module computes each `--<role>-ink` PER
// STORE, from the store's own role colour and surfaces, so a merchant palette
// can never undo it. A store whose theme sets `legacyBannerContrast: true`
// gets `--<role>-ink: var(--<role>)` instead — the ink IS the role colour, so
// it renders exactly as before (pecannbee, pinned through data, never a slug).

import { parseColorToRgb, relativeLuminance, rgbToHslTriplet, type Rgb } from './color';

/** Roles whose message text uses an ink. `primary` is the brand colour and is
 *  out of scope (Ruling YWA-TXT-1). */
export const STATUS_INK_ROLES = ['success', 'warning', 'info', 'destructive'] as const;
export type StatusInkRole = (typeof STATUS_INK_ROLES)[number];

/** Tint alphas a message sits on (`bg-<role>/N`), 0 = bare on the surface. */
export const STATUS_INK_TINTS = [0, 0.05, 0.1, 0.15, 0.2, 0.3] as const;
/** WCAG AA for body text. */
export const STATUS_INK_MIN_CONTRAST = 4.5;
/** Derivation target: AA plus headroom, so the ink still clears 4.5:1 after a
 *  consumer rounds the triplet or blends the tint in floating point. */
const DERIVE_TARGET = 4.6;

/**
 * The storefront's own role colours (apps/web globals.css, light then dark),
 * used when a theme leaves a role unset. `info` is not a theme field at all,
 * so both its light and its `.dark` value are measured.
 */
export const STATUS_ROLE_DEFAULTS: Record<StatusInkRole, readonly string[]> = {
  success: ['142 76% 36%'],
  warning: ['38 92% 50%'],
  info: ['199 89% 48%', '199 89% 55%'],
  destructive: ['0 84.2% 60.2%'],
};

/** The only non-triplet value an ink var may hold: the pass-through (a legacy
 *  store, or a palette with no readable ink — deriveStatusInk returns null). */
export const LEGACY_STATUS_INK_VALUE = /^var\(--(success|warning|info|destructive)\)$/;

interface Hsl {
  h: number;
  s: number;
  l: number;
}

function toHsl(value: string | undefined): Hsl | null {
  const rgb = parseColorToRgb(value);
  if (!rgb) return null;
  const m = /^(-?[\d.]+) (-?[\d.]+)% (-?[\d.]+)%$/.exec(rgbToHslTriplet(rgb));
  return m ? { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]) } : null;
}

const luminance = (c: Rgb) => relativeLuminance(c);
const ratio = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const blend = (fg: Rgb, bg: Rgb, a: number): Rgb => ({
  r: fg.r * a + bg.r * (1 - a),
  g: fg.g * a + bg.g * (1 - a),
  b: fg.b * a + bg.b * (1 - a),
});

/**
 * The ink for one role: the role's own hue and saturation at the lightness
 * closest to the role's that reads at >= 4.5:1 on EVERY given surface, bare
 * and under every tint in STATUS_INK_TINTS. Lighter surfaces push it darker,
 * dark ones lighter. Returns a bare `H S% L%` triplet, or `null` when no
 * lightness of the hue reads on every surface.
 *
 * `null` is not exotic (issues 2399-2402): a dark ink needs a surface at
 * relative luminance >= ~0.18, a light ink one below it, so a light card on a
 * dark page (or the reverse) has no single answer. Black or white would then
 * read on one surface and vanish on the other (1.13:1 measured) — worse than
 * the bare role colour the ink replaced. The caller falls back to that role
 * colour instead, so a contradictory palette renders exactly as it did before
 * the ink existed, never worse.
 */
export function deriveStatusInk(
  roleColors: readonly string[],
  surfaces: readonly string[]
): string | null {
  const roles = roleColors.map(v => parseColorToRgb(v)).filter((c): c is Rgb => c !== null);
  const grounds = surfaces.map(v => parseColorToRgb(v)).filter((c): c is Rgb => c !== null);
  const base = toHsl(roleColors.find(v => parseColorToRgb(v)));
  if (!base || roles.length === 0) return null;
  if (grounds.length === 0) grounds.push({ r: 255, g: 255, b: 255 });
  const backdrops = grounds.flatMap(g =>
    roles.flatMap(r => STATUS_INK_TINTS.map(a => blend(r, g, a)))
  );
  const reads = (l: number) => {
    const ink = parseColorToRgb(`${base.h} ${base.s}% ${l}%`)!;
    return backdrops.every(b => ratio(ink, b) >= DERIVE_TARGET);
  };
  const start = Math.round(base.l);
  // Nearest readable lightness to the role's own, searching both directions.
  for (let d = 0; d <= 100; d++) {
    for (const l of d === 0 ? [start] : [start - d, start + d]) {
      if (l >= 0 && l <= 100 && reads(l)) return `${base.h} ${base.s}% ${l}%`;
    }
  }
  // l = 0 and l = 100 (black, white) were in the sweep: nothing reads everywhere.
  return null;
}

/**
 * The `--<role>-ink` CSS vars for a store.
 *  - `legacy` (StoreTheme.legacyBannerContrast): `var(--<role>)` — the ink is
 *    the role colour itself, so every `text-<role>-ink` renders exactly as the
 *    `text-<role>` it replaced.
 *  - otherwise: derived per role from the given role colours (unset → the
 *    storefront default) against every given surface; where no lightness of
 *    the hue reads on every surface, the same `var(--<role>)` pass-through
 *    (never worse than before the ink — see deriveStatusInk).
 */
export function statusInkVars(
  roleColors: Partial<Record<StatusInkRole, string | undefined>>,
  surfaces: ReadonlyArray<string | undefined>,
  legacy: boolean
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const role of STATUS_INK_ROLES) {
    if (legacy) {
      out[`--${role}-ink`] = `var(--${role})`;
      continue;
    }
    const own = roleColors[role];
    const colors = own && parseColorToRgb(own) ? [own] : [...STATUS_ROLE_DEFAULTS[role]];
    out[`--${role}-ink`] =
      deriveStatusInk(
        colors,
        surfaces.filter((s): s is string => !!s)
      ) ?? `var(--${role})`;
  }
  return out;
}
