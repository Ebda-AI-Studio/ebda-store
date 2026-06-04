'use client';

import { useStore } from '../../contexts/StoreContext';
import {
  DEFAULT_DIVIDER_SETTINGS,
  resolveColor,
  type DividerSettings,
  type SectionDividers,
  type StoreTheme,
} from '@force/shared';

/** The five divider slots a section can render, in storefront top-to-bottom order. */
const DIVIDER_SLOTS = ['above', 'kicker', 'title', 'subtitle', 'belowHeading'] as const;
type DividerSlotKey = (typeof DIVIDER_SLOTS)[number];

/** True when a slot carries an explicit merchant style pick (vs. just `enabled`). */
export function hasExplicitDividerPick(slot: Partial<DividerSettings> | undefined): boolean {
  return (
    !!slot && (slot.color !== undefined || !!slot.customColor || !!slot.thickness || !!slot.style)
  );
}

/**
 * A slot with `customColor` set but no `color` mode is custom by intent — the
 * admin only ever writes `customColor` through the custom ColorField, which is
 * gated behind selecting "Custom". When `color` is left undefined it falls back
 * to DEFAULT_DIVIDER_SETTINGS.color ('foreground'), and resolveDividerColor then
 * IGNORES customColor (it only reads it in the `color: 'custom'` branch) — so the
 * merchant's pick silently rendered as the grey foreground hairline. Verified
 * live FWB 2026-06-04: categories title divider saved as
 * `{ enabled: true, customColor: 'token:card' }` rendered foreground/0.30.
 * Normalising customColor → custom here fixes it for every consumer without a
 * re-save and without resurrecting a stale customColor (a slot that has no
 * customColor is untouched).
 */
function normalizeCustomColorMode(
  slot: Partial<DividerSettings> | undefined
): Partial<DividerSettings> | undefined {
  if (slot && slot.customColor && slot.color === undefined) {
    return { ...slot, color: 'custom' };
  }
  return slot;
}

/**
 * Resolve the effective settings for ONE divider slot within a section.
 *
 * The page-builder admin exposes a SINGLE shared colour/style control per
 * section that is meant to apply to every enabled slot ("the styling below
 * applies to all enabled slots so they stay visually consistent"). The admin
 * only fans that style onto slots that already exist, so a slot enabled AFTER
 * the colour was picked gets saved as `{ enabled: true }` only. Slots that
 * default OFF — "Around title", "Above this section", "Below heading" — commonly
 * miss the fan-out while "Around subtitle" (default ON) keeps the pick. The
 * result was the missing slots rendering the default foreground hairline instead
 * of the merchant's colour (Ahmad 2026-06-04: "do not take the color i picked").
 *
 * This makes every slot inherit the section's shared pick when it has none of
 * its own — honouring the admin's intent AND repairing already-saved stores
 * without a re-save. The slot's own `enabled` (and any own style fields) always
 * win; the shared pick's `enabled` is never leaked.
 */
export function resolveSlotDividerSettings(
  dividers: SectionDividers | undefined,
  slot: DividerSlotKey
): Partial<DividerSettings> | undefined {
  const own = dividers?.[slot];
  if (!own) return own;
  if (hasExplicitDividerPick(own)) return normalizeCustomColorMode(own);
  const shared = DIVIDER_SLOTS.map(k => dividers?.[k]).find(hasExplicitDividerPick);
  if (!shared) return own;
  // Inherit the shared pick's STYLE only (never its `enabled`); the slot's own
  // fields — including its `enabled` — always win.
  const inherited: Partial<DividerSettings> = {
    style: shared.style,
    thickness: shared.thickness,
    width: shared.width,
    color: shared.color,
    customColor: shared.customColor,
    spacing: shared.spacing,
  };
  return normalizeCustomColorMode({ ...inherited, ...own });
}

interface SectionDividerProps {
  /**
   * Per-section divider settings (partial). When provided AND
   * `enabled !== false`, renders the divider with these settings merged over
   * DEFAULT_DIVIDER_SETTINGS. When `enabled === false`, renders nothing.
   *
   * When NOT provided (undefined), falls back to legacy `theme.dividers`
   * (platform-wide setting) to preserve existing stores' look. Once a
   * merchant sets per-section dividers via the new page-builder UI, the
   * per-section value wins.
   */
  settings?: Partial<DividerSettings>;
  /**
   * When true (caller indicates one or both adjacent sections have an
   * explicit per-section bgColor), hide the divider — the color shift IS
   * the separator. Same idiom as the theme.backgroundPreset mutex below.
   *
   * HomePageContent computes this from flanking sections' bgColor fields
   * and passes the flag at each call site so merchants get correct
   * double-separation suppression even when they haven't changed the
   * global backgroundPreset.
   */
  hideForExplicitBg?: boolean;
}

/**
 * Horizontal section divider — rendered between homepage sections OR
 * between heading parts (kicker/title/subtitle) within a section.
 *
 * Per Ahmad 2026-05-20: the platform-wide admin card is removed; each
 * section owns its dividers via `layout.<section>.dividers.{above,
 * kicker, title, subtitle, belowHeading}`. The storefront still falls
 * back to legacy `theme.dividers` when no per-section setting is passed,
 * so existing stores keep their current look.
 *
 * Returns null when:
 *   - settings.enabled === false (merchant explicitly turned it off)
 *   - no per-section settings AND no legacy `theme.dividers` either
 *   - theme.backgroundPreset !== 'none' (alternation IS the divider)
 *   - hideForExplicitBg === true (adjacent per-section bgColors set)
 */
export function SectionDivider({ settings, hideForExplicitBg }: SectionDividerProps = {}) {
  const { store } = useStore();

  // Per-section settings win when provided. Legacy theme.dividers is the
  // fallback for the between-section `above` slot only — only HomePageContent
  // calls without an explicit `settings` prop, and that's the legacy path.
  const merged: DividerSettings = settings
    ? { ...DEFAULT_DIVIDER_SETTINGS, ...settings }
    : { ...DEFAULT_DIVIDER_SETTINGS, ...(store.theme?.dividers ?? {}) };

  if (!merged.enabled) return null;

  // Explicit per-section override (settings prop provided + enabled true) wins
  // over BOTH the backgroundPreset mutex AND the per-section bgColor mutex.
  // The merchant explicitly opted in via the page-builder Section dividers
  // toggle — honor that intent regardless of any auto-suppression rules that
  // applied to the legacy platform-wide divider. Verified 2026-05-20 when
  // Ahmad reported "Section dividers are not rendering in storefront while
  // it's on in admin for wadyaljuz" — wadyaljuz's `theme.backgroundPreset`
  // was non-'none' which was suppressing every between-section divider via
  // the mutex below.
  const isExplicitOverride = settings !== undefined && settings.enabled === true;

  if (!isExplicitOverride) {
    // Mutual exclusion with backgroundPreset (legacy 2026-05-17 evening):
    // both systems separate sections visually — running them together is
    // unpleasant double-separation. Only applies to between-section dividers;
    // intra-section line dividers (kicker/title/subtitle) bypass this check
    // because they're not affected by background alternation.
    const bgPreset = store.theme?.backgroundPreset ?? 'none';
    if (bgPreset !== 'none' && hideForExplicitBg !== undefined) return null;

    // Per-section bgColor mutex (2026-05-19): merchants can color individual
    // sections without changing the global backgroundPreset. When either
    // flanking section has an explicit bgColor, the color shift already
    // acts as a separator — suppress the <hr> to avoid double-separation.
    if (hideForExplicitBg) return null;
  }

  // Color resolution — single source of truth so the admin live preview
  // and the storefront render stay in lockstep.
  const colorCss = resolveDividerColor(merged, store.theme);

  // Vertical padding bands per spacing token. Padding sits OUTSIDE the
  // line itself so adjacent sections don't grow when dividers turn on.
  const paddingClass =
    merged.spacing === 'tight'
      ? 'py-3 sm:py-4'
      : merged.spacing === 'loose'
        ? 'py-8 sm:py-12'
        : 'py-5 sm:py-8';

  // Width: edge-to-edge OR contained inside the page max-w-7xl OR a
  // short centered accent. Default 'short' = 140-200px to match the
  // SectionKicker hairlines that flank section titles (Ahmad 2026-05-17).
  const containerClass =
    merged.width === 'full'
      ? 'w-full'
      : merged.width === 'short'
        ? 'mx-auto w-[140px] sm:w-[200px]'
        : 'mx-auto max-w-7xl px-4 sm:px-6 lg:px-8';

  return (
    <div className={paddingClass} aria-hidden>
      <div className={containerClass}>
        <hr
          className="m-0 border-0 border-t"
          style={{
            borderTopStyle: merged.style,
            borderTopWidth: `${merged.thickness}px`,
            borderTopColor: colorCss,
          }}
        />
      </div>
    </div>
  );
}

export function resolveDividerColor(
  settings: DividerSettings,
  theme: StoreTheme | undefined
): string {
  switch (settings.color) {
    case 'foreground':
      // 0.30 matches the SectionKicker hairline opacity (bg-foreground/30)
      // exactly — Ahmad's reference 2026-05-17 evening.
      return 'hsl(var(--foreground) / 0.30)';
    case 'accent':
      return theme?.primaryColor ? `hsl(${theme.primaryColor})` : 'hsl(var(--primary))';
    case 'custom':
      // 2026-05-20: customColor now accepts EITHER a raw hex (#RRGGBB) OR
      // a brand token reference (token:primary / token:accent / etc).
      // - hex / hsl() passes through unchanged
      // - token:<name> resolves via theme[<name>Color]; if that field is
      //   undefined on the theme (older theme rows are missing card/muted/
      //   border etc.), fall back to the global CSS variable which exists
      //   in globals.css for every shadcn token. Returning the literal
      //   "token:card" string would be silently dropped by the browser
      //   — verified FWB 2026-05-20.
      if (settings.customColor) {
        const v = settings.customColor;
        if (v.startsWith('token:')) {
          if (theme) {
            const resolved = resolveColor(v, theme);
            if (resolved) return resolved;
          }
          const key = v.slice('token:'.length);
          if (/^[a-zA-Z][a-zA-Z0-9-]{0,32}$/.test(key)) {
            return `hsl(var(--${key}))`;
          }
          return 'hsl(var(--border))';
        }
        return v;
      }
      return 'hsl(var(--border))';
    case 'auto':
    default:
      return 'hsl(var(--border))';
  }
}
