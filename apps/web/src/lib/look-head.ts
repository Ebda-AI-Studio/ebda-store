import { getLook, lookFontsHref } from '@force/shared';

/**
 * Head/body hooks for a store's look. Everything is null for a legacy store
 * (no/unknown look), so legacy markup is unchanged (Ruling R1).
 */
export function lookHead(lookId: string | null | undefined): {
  dataLook: string;
  fontsHref: string;
} | null {
  const look = getLook(lookId);
  if (!look) return null;
  return {
    dataLook: look.id,
    fontsHref: lookFontsHref(look),
  };
}
