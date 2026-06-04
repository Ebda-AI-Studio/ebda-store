import { resolveColor } from '@force/shared';
import type { ZoneOverride, StoreTheme } from '@force/shared';
import type { CSSProperties } from 'react';

export interface ResolvedZone {
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  color?: string;
  letterSpacing?: string;
  lineHeight?: string;
  textTransform?: string;
  textDecoration?: string;
  textAlign?: 'start' | 'center' | 'end';
}

/**
 * Merge a section-level typography override with the global zone from the
 * typography admin. Section override wins per-field; global fills the rest;
 * theme defaults handle anything not set anywhere. Returns undefined when
 * neither has any value so the caller can render with raw theme defaults.
 *
 * Color values (hex OR 'token:<name>') are resolved against the live theme
 * here so the consumer always gets a real CSS color string.
 */
export function resolveSectionZone(
  sectionOverride: ZoneOverride | undefined,
  globalZone: ZoneOverride | undefined,
  theme: StoreTheme
): ResolvedZone | undefined {
  if (!sectionOverride && !globalZone) return undefined;

  const merged: ResolvedZone = {};
  const pick = <K extends keyof ZoneOverride>(key: K) => {
    const v = sectionOverride?.[key] ?? globalZone?.[key];
    if (v !== undefined) {
      (merged as Record<string, unknown>)[key] = v;
    }
  };

  pick('fontFamily');
  pick('fontSize');
  pick('fontWeight');
  pick('letterSpacing');
  pick('lineHeight');
  pick('textTransform');
  pick('textDecoration');
  pick('textAlign');

  // Color goes through resolveColor so token: refs work at the override level too.
  const rawColor = sectionOverride?.color ?? globalZone?.color;
  if (rawColor) {
    merged.color = resolveColor(rawColor, theme);
  }

  return Object.keys(merged).length ? merged : undefined;
}

/**
 * Wrap a merchant-set px fontSize with a responsive `clamp()` so it scales
 * gracefully on narrow mobile. Mobile floor = max(70% of merchant value, 14px).
 * At ≥768px viewport, renders at the merchant value. Linear interp in between.
 *
 * Returns the original value unchanged when:
 *   - undefined
 *   - non-px unit (em / rem / % / vw)
 *   - already ≤16px (already mobile-safe)
 *
 * Verified 2026-05-20 against wadyaljuz: global sectionTitle.fontSize="22px"
 * → clamp(15.40px, calc(8.82px + 1.716vw), 22px) → renders 15.4px on 360px
 * mobile, 22px on tablet+. Was previously 22px on every viewport, which
 * broke mobile heading wrap.
 */
export function responsiveFontSize(size: string | undefined): string | undefined {
  if (!size) return undefined;
  const match = size.match(/^([\d.]+)px$/);
  if (!match) return size; // non-px unit — return as-is
  const value = parseFloat(match[1]);
  if (value <= 16) return size; // already mobile-safe
  const mobileFloor = Math.max(value * 0.7, 14);
  // Linear interp from mobileFloor @ 360px → value @ 768px viewport
  const slope = (value - mobileFloor) / (768 - 360);
  const intercept = mobileFloor - slope * 360;
  return `clamp(${mobileFloor.toFixed(2)}px, calc(${intercept.toFixed(2)}px + ${(slope * 100).toFixed(3)}vw), ${value}px)`;
}

/**
 * Convert a resolved zone to an inline style object. Inline wins over the
 * element's own Tailwind size classes — the reliable way to apply a merchant's
 * per-page typography (used by the cart + the per-page design controls). Returns
 * undefined when the zone is empty so callers can spread it safely.
 */
/** Multiply a px font-size by the page text-scale before the responsive clamp.
 *  Non-px sizes pass through unscaled (can't safely multiply em/rem here). */
function scalePx(size: string | undefined, scale: number): string | undefined {
  if (!size || scale === 1) return size;
  const m = size.match(/^([\d.]+)px$/);
  if (!m) return size;
  return `${(parseFloat(m[1]) * scale).toFixed(2)}px`;
}

/**
 * @param scale per-page text-size multiplier (see pageTextScale). 1 = unchanged.
 */
export function zoneStyle(zone?: ResolvedZone, scale = 1): CSSProperties | undefined {
  if (!zone) return undefined;
  return {
    fontFamily: zone.fontFamily,
    // Scale by the page text dial, then responsive-clamp so a large size never
    // breaks mobile.
    fontSize: responsiveFontSize(scalePx(zone.fontSize, scale)),
    fontWeight: zone.fontWeight,
    color: zone.color,
    letterSpacing: zone.letterSpacing,
    // Ratio safety (mirrors the homepage CSS emitter): when the merchant bumps
    // the size but doesn't set a line-height, pin an Arabic-friendly 1.6 so the
    // bigger glyphs (ش / خ / ة with upper diacritics) always have vertical room
    // and don't clip against a tight default. Merchant-set line-height wins.
    lineHeight: zone.lineHeight ?? (zone.fontSize ? '1.6' : undefined),
    textTransform: zone.textTransform as CSSProperties['textTransform'],
    textAlign: zone.textAlign,
  };
}

/** Map a per-page text-scale dial to a numeric multiplier. */
export function pageTextScale(scale: 'sm' | 'normal' | 'lg' | 'xl' | undefined): number {
  return scale === 'sm' ? 0.9 : scale === 'lg' ? 1.15 : scale === 'xl' ? 1.3 : 1;
}

/** Return a copy of a zone with its px font-size multiplied by `scale`. Used
 *  when a zone is forwarded into a theme component that applies it itself
 *  (cart CartTable/OrderSummary, category cards) rather than via zoneStyle(). */
export function scaleZone(zone: ResolvedZone | undefined, scale: number): ResolvedZone | undefined {
  if (!zone || scale === 1) return zone;
  return { ...zone, fontSize: scalePx(zone.fontSize, scale) };
}

/**
 * Per-page spacing density → inline padding override for the page container.
 * 'normal'/undefined returns undefined so the element's default py- class wins.
 */
export function pageDensityStyle(
  density: 'compact' | 'normal' | 'spacious' | undefined
): CSSProperties | undefined {
  if (density === 'compact') return { paddingTop: '1rem', paddingBottom: '1rem' };
  if (density === 'spacious') return { paddingTop: '3.5rem', paddingBottom: '3.5rem' };
  return undefined;
}
