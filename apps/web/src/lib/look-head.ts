import { getLook, lookFontsHref, resolveLookFonts } from '@ebda/shared';
import { LOOK_FONT_FACES } from './look-font-faces.generated';

/**
 * Self-hosted @font-face CSS for the families a look store paints (SEO-5), replacing the render-blocking
 * fonts.googleapis.com stylesheet. Only the subsets/weights `LOOK_FONT_SPECS` lists; unicode-range keeps the
 * browser from fetching a subset the page never uses.
 */
export function lookFontFacesCss(families: string[]): string {
  return [...new Set(families)].flatMap(f => (LOOK_FONT_FACES[f] ?? []).map(r => r.css)).join('\n');
}

/** The one file worth a `<link rel=preload>` for a family: the Arabic (else Latin) 400 face. */
export function primaryFontFile(family: string): string | null {
  const faces = LOOK_FONT_FACES[family] ?? [];
  const pick = (subset: string) =>
    faces.filter(f => f.subset === subset).find(f => /font-weight:\s*400\b/.test(f.css)) ??
    faces.find(f => f.subset === subset);
  const f = pick('arabic') ?? pick('latin');
  return f ? `/fonts/look/${f.file}` : null;
}

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
  fontFacesCss: string;
  preloadFonts: string[];
} | null {
  const look = getLook(lookId);
  if (!look) return null;
  const { display, body } = resolveLookFonts(look, theme ?? {});
  const families = [...new Set(Object.values(resolveLookFonts(look, theme ?? {})))];
  return {
    dataLook: look.id,
    // The families the store paints: a loadable merchant override replaces the look's face.
    // `fontsHref` stays the canonical family list (tests, tooling); pages use the self-hosted faces.
    fontsHref: lookFontsHref(look, theme ?? {}),
    fontFacesCss: lookFontFacesCss(families),
    preloadFonts: [
      ...new Set([primaryFontFile(body), primaryFontFile(display)].filter((x): x is string => !!x)),
    ],
  };
}
