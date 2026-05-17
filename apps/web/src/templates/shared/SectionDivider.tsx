'use client';

import { useStore } from '../../contexts/StoreContext';
import { DEFAULT_DIVIDER_SETTINGS, type DividerSettings } from '@force/shared';

/**
 * Horizontal section divider — drawn between homepage sections per
 * `store.theme.dividers`. Default-on so every store gets a visible
 * separator without merchant action; merchants tune style/color/etc.
 * via Admin → Dividers.
 *
 * Independent of `backgroundPreset` — the two systems can coexist
 * (alternating bg AND a hairline line) or work alone.
 *
 * Returns null when `enabled === false` so the page renders edge-to-edge
 * without the wrapper.
 */
export function SectionDivider() {
  const { store } = useStore();
  const settings: DividerSettings = {
    ...DEFAULT_DIVIDER_SETTINGS,
    ...(store.theme?.dividers ?? {}),
  };
  if (!settings.enabled) return null;

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
