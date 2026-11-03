/**
 * Per-section vertical spacing, per device (editor Ruling SP-1).
 *
 * One table is the truth for the admin readout ("48px") and for the storefront class map
 * (`apps/web/.../section-spacing.ts` is pinned to this table by a parity test).
 * Resolution order for one axis on one device:
 *   device value -> base value -> preset column of that device -> baseline (`normal`).
 */
import type { SectionSpacingPreset } from '../types/store-layout';
import type { Viewport } from './viewports';

export const SECTION_SPACING_PRESETS: readonly SectionSpacingPreset[] = [
  'none',
  'tight',
  'normal',
  'loose',
  'xloose',
  'xxloose',
];

/** px per device at each preset (Tailwind units x 4: normal = 12 / 16 / 20 -> 48 / 64 / 80). */
export const SECTION_SPACING_PX: Record<SectionSpacingPreset, Record<Viewport, number>> = {
  none: { mobile: 0, tablet: 0, desktop: 0 },
  tight: { mobile: 16, tablet: 24, desktop: 32 },
  normal: { mobile: 48, tablet: 64, desktop: 80 },
  loose: { mobile: 64, tablet: 80, desktop: 112 },
  xloose: { mobile: 96, tablet: 112, desktop: 144 },
  xxloose: { mobile: 112, tablet: 144, desktop: 176 },
};

export type SpacingAxis = 'Top' | 'Bottom';

/** The setting key for an axis on a device: desktop / base is `paddingTop`, the rest `paddingTopTablet`... */
export const spacingLegacyKey = (axis: SpacingAxis, viewport: Viewport): string =>
  viewport === 'desktop'
    ? `padding${axis}`
    : `padding${axis}${viewport === 'tablet' ? 'Tablet' : 'Mobile'}`;

/** The four legacy bridge keys (tablet + mobile, both axes). */
export const SPACING_DEVICE_LEGACY_KEYS = [
  'paddingTopTablet',
  'paddingTopMobile',
  'paddingBottomTablet',
  'paddingBottomMobile',
] as const;

const isPreset = (v: unknown): v is SectionSpacingPreset =>
  typeof v === 'string' && (SECTION_SPACING_PRESETS as readonly string[]).includes(v);

/**
 * The preset in force for `axis` on `viewport`. `values` is the legacy-shaped object
 * (`paddingTop`, `paddingTopTablet`, ...). `undefined` = nothing set anywhere (the section keeps
 * its baseline classes and the look's density).
 */
export function resolveSpacingPreset(
  values: Partial<Record<string, unknown>> | undefined,
  axis: SpacingAxis,
  viewport: Viewport
): SectionSpacingPreset | undefined {
  if (!values) return undefined;
  const device = values[spacingLegacyKey(axis, viewport)];
  if (isPreset(device)) return device;
  const base = values[`padding${axis}`];
  return isPreset(base) ? base : undefined;
}

/** px on `viewport`, falling to the baseline (`normal`) when nothing is set. */
export function resolveSpacingPx(
  values: Partial<Record<string, unknown>> | undefined,
  axis: SpacingAxis,
  viewport: Viewport
): number {
  return SECTION_SPACING_PX[resolveSpacingPreset(values, axis, viewport) ?? 'normal'][viewport];
}

/** True when either axis carries a tablet or mobile value. */
export const hasDeviceSpacing = (values: Partial<Record<string, unknown>> | undefined): boolean =>
  !!values && SPACING_DEVICE_LEGACY_KEYS.some(k => isPreset(values[k]));
