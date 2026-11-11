/**
 * The merchant admin's design tokens, in ONE place (ruling docs/rulings/ADM-DS-1.md).
 *
 * Colours live as CSS variables in styles/globals.css (night + Ebda gold; no orange, no blue/violet chrome).
 * Everything else the admin repeats lives here as class names over the foundation values: type, radii, control + nav heights, elevation, motion, z-index.
 * tests/unit/admin-design-tokens.test.ts fails on raw palette colours, hex literals, `text-[Npx]`,
 * bare `rounded` and self-styled `data-ui="nav"` items outside these tokens (a shrinking baseline holds the
 * pages not yet migrated: waves W2/W3).
 *
 * Arabic rules baked in: no negative letter-spacing anywhere, body leading >= 1.6 for Arabic, weights 400-600,
 * 12px is for counters/badges only (never the sole carrier of meaning).
 */

import {
  CONTROL,
  ELEVATION as FDN_ELEVATION,
  MOTION,
  NAV,
  RADIUS as FDN_RADIUS,
  SPACE,
  TYPE as FDN_TYPE,
  Z,
} from '@ebda/shared/design';

/**
 * Values come from the vendored foundation (@ebda/shared/design, ebda-foundation design language v1); this file only
 * maps them to the admin's Tailwind class names. tests/unit/admin-design-tokens-sync.test.ts proves each class maps
 * to the foundation value, so a class and its token can never drift apart.
 */
export { MOTION, SPACE, Z };

/** Type scale: Tailwind class (px + [latin, arabic] leading come from the foundation). Page title is `title`. */
export const TYPE = {
  caption: { cls: 'text-xs', ...FDN_TYPE.caption },
  ui: { cls: 'text-sm', ...FDN_TYPE.ui },
  body: { cls: 'text-base', ...FDN_TYPE.body },
  titleSm: { cls: 'text-lg', ...FDN_TYPE.titleSm },
  title: { cls: 'text-xl', ...FDN_TYPE.title },
  kpi: { cls: 'text-2xl', ...FDN_TYPE.kpi },
  display: { cls: 'text-3xl', ...FDN_TYPE.display },
} as const;

/** Radii: control (rounded-md), surface (rounded-lg = --radius), pill (rounded-full). Pixel values: foundation RADIUS. */
export const RADIUS = {
  control: 'rounded-md',
  surface: 'rounded-lg',
  pill: 'rounded-full',
} as const;
export const RADIUS_PX = FDN_RADIUS;

/** Heights in px: every interactive control (button, input, select, nav item) sits on one of these. */
export const CONTROL_HEIGHT = CONTROL;
export const NAV_HEIGHT = NAV;

/** Elevation: 0 flat hairline (default), 1 cards, 2 menus/popovers, 3 modals/sheets. No coloured shadows. Shadow values: foundation ELEVATION. */
export const ELEVATION = {
  flat: '',
  card: 'shadow-sm',
  menu: 'shadow-md',
  modal: 'shadow-xl',
} as const;
export const ELEVATION_VALUES = FDN_ELEVATION;

export type NavKind = 'sidebar' | 'tab' | 'rail';

const NAV_BASE =
  'relative inline-flex items-center rounded-md text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

const NAV_SIZE: Record<NavKind, string> = {
  // 44px, icon tile + label, full row.
  sidebar: 'min-h-11 w-full gap-3 px-3 font-medium',
  // 44px on phones, 40px from md up; sized to its label inside a scroll strip.
  tab: 'min-h-11 md:min-h-10 shrink-0 whitespace-nowrap px-3',
  // 40px list row in the settings rail.
  rail: 'min-h-10 w-full px-3',
};

/**
 * ONE active language for every navigation item: the `soft` tint (bg-primary/15 + primary-ink text).
 * Inactive items are muted text with an accent hover. Text on the tint uses `primary-ink`, never `text-primary` (3.1:1 on light).
 */
export function navItemClasses({
  kind,
  active,
  className,
}: {
  kind: NavKind;
  active: boolean;
  className?: string;
}): string {
  const state = active
    ? 'bg-primary/15 text-primary-ink font-medium'
    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground';
  return [NAV_BASE, NAV_SIZE[kind], state, className].filter(Boolean).join(' ');
}

/** The mobile bottom bar tab: 56px tall column, label 12px (a counter-size label, icon carries meaning). */
export function bottomNavClasses(active: boolean): string {
  return [
    'flex h-14 flex-col items-center justify-center gap-0.5 text-xs font-medium transition-colors duration-150',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
    active ? 'text-primary-ink' : 'text-muted-foreground hover:text-foreground',
  ].join(' ');
}
