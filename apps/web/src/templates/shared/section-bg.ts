import type { CSSProperties } from 'react';
import { resolveColor, pickReadableForeground } from '@force/shared';
import type { StoreTheme } from '@force/shared';

/**
 * Map a per-section bgColor (hex OR token:<name>) to an inline style object that
 * sets backgroundColor AND a `--section-fg` CSS custom property with the
 * auto-picked readable foreground. Returns undefined when no bg is set so the
 * section falls back to its theme-level background.
 *
 * The `--section-fg` cascades into the section's heading/kicker/subtitle text
 * via globals.css so a merchant who picks brand primary as bg never ships
 * unreadable headings.
 */
export function sectionBgStyle(
  bgColor: string | undefined,
  theme: StoreTheme
): CSSProperties | undefined {
  const resolved = resolveColor(bgColor, theme);
  if (!resolved) return undefined;
  const fg = pickReadableForeground(resolved);
  return {
    backgroundColor: resolved,
    ...(fg ? ({ ['--section-fg' as string]: fg } as CSSProperties) : {}),
  };
}
