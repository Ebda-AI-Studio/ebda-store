'use client';

import { useStore } from '../../contexts/StoreContext';
import { DEFAULT_DIVIDER_SETTINGS, type DividerSettings } from '@force/shared';

interface SectionDividerProps {
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
 * Horizontal section divider — drawn between homepage sections per
 * `store.theme.dividers`. Default-on so every store gets a visible
 * separator without merchant action; merchants tune style/color/etc.
 * via Admin → Dividers.
 *
 * Returns null when:
 *   - `enabled === false` (merchant turned dividers off)
 *   - `theme.backgroundPreset !== 'none'` (alternation IS the divider)
 *   - `hideForExplicitBg === true` (caller indicates adjacent per-section
 *     bgColors are set, making the color shift the separator)
 */
export function SectionDivider({ hideForExplicitBg }: SectionDividerProps = {}) {
  const { store } = useStore();
  const settings: DividerSettings = {
    ...DEFAULT_DIVIDER_SETTINGS,
    ...(store.theme?.dividers ?? {}),
  };
  if (!settings.enabled) return null;

  // Mutual exclusion with backgroundPreset (Ahmad 2026-05-17 evening):
  // both systems separate sections visually — running them together is
  // unpleasant double-separation. When the merchant picked a bg preset,
  // the alternation IS the divider; render no <hr>. Dividers only paint
  // when bg preset is `none` (or unset), so flat-bg stores still get a
  // visible separator.
  const bgPreset = store.theme?.backgroundPreset ?? 'none';
  if (bgPreset !== 'none') return null;

  // Per-section bgColor mutex (2026-05-19): merchants can color individual
  // sections without changing the global backgroundPreset. When either
  // flanking section has an explicit bgColor, the color shift already
  // acts as a separator — suppress the <hr> to avoid double-separation.
  if (hideForExplicitBg) return null;

  // Color resolution — single source of truth so the admin live preview
  // and the storefront render stay in lockstep.
  const colorCss = resolveDividerColor(settings, store.theme?.primaryColor);

  // Vertical padding bands per spacing token. Padding sits OUTSIDE the
  // line itself so adjacent sections don't grow when dividers turn on.
  const paddingClass =
    settings.spacing === 'tight'
      ? 'py-3 sm:py-4'
      : settings.spacing === 'loose'
        ? 'py-8 sm:py-12'
        : 'py-5 sm:py-8';

  // Width: edge-to-edge OR contained inside the page max-w-7xl OR a
  // short centered accent. Default 'short' = 140-200px to match the
  // SectionKicker hairlines that flank section titles (Ahmad 2026-05-17).
  const containerClass =
    settings.width === 'full'
      ? 'w-full'
      : settings.width === 'short'
        ? 'mx-auto w-[140px] sm:w-[200px]'
        : 'mx-auto max-w-7xl px-4 sm:px-6 lg:px-8';

  return (
    <div className={paddingClass} aria-hidden>
      <div className={containerClass}>
        <hr
          className="m-0 border-0 border-t"
          style={{
            borderTopStyle: settings.style,
            borderTopWidth: `${settings.thickness}px`,
            borderTopColor: colorCss,
          }}
        />
      </div>
    </div>
  );
}

function resolveDividerColor(settings: DividerSettings, primaryColor?: string): string {
  switch (settings.color) {
    case 'foreground':
      // 0.30 matches the SectionKicker hairline opacity (bg-foreground/30)
      // exactly — Ahmad's reference 2026-05-17 evening.
      return 'hsl(var(--foreground) / 0.30)';
    case 'accent':
      return primaryColor ? `hsl(${primaryColor})` : 'hsl(var(--primary))';
    case 'custom':
      return settings.customColor || 'hsl(var(--border))';
    case 'auto':
    default:
      return 'hsl(var(--border))';
  }
}
