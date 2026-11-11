/**
 * The merchant admin's design tokens, in ONE place (ruling docs/rulings/ADM-DS-1.md).
 *
 * Colours live as CSS variables in styles/globals.css (night + Ebda gold; no orange, no blue/violet chrome).
 * Everything else the admin repeats lives here: type, radii, control + nav heights, elevation, motion, z-index.
 * tests/unit/admin-design-tokens.test.ts fails on raw palette colours, hex literals, `text-[Npx]`,
 * bare `rounded` and self-styled `data-ui="nav"` items outside these tokens (a shrinking baseline holds the
 * pages not yet migrated: waves W2/W3).
 *
 * Arabic rules baked in: no negative letter-spacing anywhere, body leading >= 1.6 for Arabic, weights 400-600,
 * 12px is for counters/badges only (never the sole carrier of meaning).
 */

/** Type scale: Tailwind class, px, and the [latin, arabic] leading in px. Page title is `title`. */
export const TYPE = {
  caption: { cls: 'text-xs', px: 12, leading: [16, 20] },
  ui: { cls: 'text-sm', px: 14, leading: [20, 24] },
  body: { cls: 'text-base', px: 16, leading: [24, 28] },
  titleSm: { cls: 'text-lg', px: 18, leading: [24, 30] },
  title: { cls: 'text-xl', px: 20, leading: [28, 32] },
  kpi: { cls: 'text-2xl', px: 24, leading: [32, 36] },
  display: { cls: 'text-3xl', px: 30, leading: [36, 44] },
} as const;

/** 4px base. Page gutter 16 (phones) / 24 (lg); card padding 16 lists / 24 forms. */
export const SPACE = [4, 8, 12, 16, 24, 32, 48] as const;

/** Radii: control 12 (rounded-md), surface 14 (rounded-lg = --radius), pill (rounded-full). */
export const RADIUS = {
  control: 'rounded-md',
  surface: 'rounded-lg',
  pill: 'rounded-full',
} as const;

/** Heights in px: every interactive control (button, input, select, nav item) sits on one of these. */
export const CONTROL_HEIGHT = { sm: 32, md: 40, mdPhone: 44, lg: 44 } as const;
export const NAV_HEIGHT = { sidebar: 44, tab: 40, tabPhone: 44, rail: 40, bottom: 56 } as const;

/** Elevation: 0 flat hairline (default), 1 cards, 2 menus/popovers, 3 modals/sheets. No coloured shadows. */
export const ELEVATION = {
  flat: '',
  card: 'shadow-sm',
  menu: 'shadow-md',
  modal: 'shadow-xl',
} as const;

/** Motion: durations in ms and the one easing. Slides mirror in RTL; reduced-motion turns them off. */
export const MOTION = {
  fast: 150,
  base: 200,
  slow: 300,
  ease: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;

/** z-index ladder. */
export const Z = {
  sticky: 10,
  header: 20,
  bottomBar: 30,
  drawer: 40,
  modal: 50,
  toast: 60,
} as const;

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
