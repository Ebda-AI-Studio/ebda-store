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
