import { getLook, lookFontsHref } from '@force/shared';

/**
 * Head/body hooks for a store's look. Everything is null for a legacy store
 * (no/unknown look), so legacy markup is unchanged (Ruling R1).
 * `--font-latin` is not a StoreTheme key, so it is derived from the look id here.
 */
export function lookHead(lookId: string | null | undefined): {
  dataLook: string;
  fontsHref: string;
  latinCss: string;
} | null {
  const look = getLook(lookId);
  if (!look) return null;
  return {
    dataLook: look.id,
    fontsHref: lookFontsHref(look),
    latinCss: `:root { --font-latin: "${look.tokens.fonts.latin}", var(--font-sans) }`,
  };
}
