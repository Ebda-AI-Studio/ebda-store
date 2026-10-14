import { getLook, lookFontsHref } from '@force/shared';

/**
 * Head/body hooks for a store's look. Everything is null for a legacy store
 * (no/unknown look), so legacy markup is unchanged (Ruling R1; sole exception: the inert mobile-menu fix, Ruling LOOKS-17).
 */
export function lookHead(
  lookId: string | null | undefined,
  theme?: { headingFont?: unknown; bodyFont?: unknown } | null
): {
  dataLook: string;
  fontsHref: string;
} | null {
  const look = getLook(lookId);
  if (!look) return null;
  return {
    dataLook: look.id,
    // The families the store paints: a loadable merchant override replaces the look's face.
    fontsHref: lookFontsHref(look, theme ?? {}),
  };
}
