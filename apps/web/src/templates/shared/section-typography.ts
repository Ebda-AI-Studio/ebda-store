import { resolveColor } from '@force/shared';
import type { ZoneOverride, StoreTheme } from '@force/shared';

export interface ResolvedZone {
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  color?: string;
  letterSpacing?: string;
  lineHeight?: string;
  textTransform?: string;
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
