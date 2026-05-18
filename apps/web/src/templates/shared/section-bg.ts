import type { CSSProperties } from 'react';

/**
 * Map a per-section bgColor (hex string) to an inline style object.
 * Returns `undefined` when the merchant hasn't picked a color so the
 * section wrapper falls back to its theme-level background (the
 * backgroundPreset alternation or the default --bg-page).
 *
 * Only accepts hex colors validated by the Zod schema — never lets
 * a merchant inject `expression()` / `url()` style values.
 */
export function sectionBgStyle(bgColor: string | undefined): CSSProperties | undefined {
  if (!bgColor) return undefined;
  if (!/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?$/.test(bgColor)) return undefined;
  return { backgroundColor: bgColor };
}
