import type { LookDefinition } from './types';

/** Weights per family actually used by the looks. '' = the family ships one weight only. */
export const LOOK_FONT_SPECS: Record<string, string> = {
  'Noto Naskh Arabic': 'wght@400;700',
  'IBM Plex Sans Arabic': 'wght@400;500;600;700',
  'Cormorant Garamond': 'wght@600',
  Lalezar: '',
  Tajawal: 'wght@400;500;700',
  Archivo: 'wght@500;700',
  'Aref Ruqaa': 'wght@400;700',
  'Noto Sans Arabic': 'wght@400;500;600;700',
  'Playfair Display': 'wght@600',
  'IBM Plex Sans': 'wght@500;600',
  Changa: 'wght@600;700',
  Cairo: 'wght@400;600;700',
  Manrope: 'wght@600;700',
  Alexandria: 'wght@500;700',
  'Readex Pro': 'wght@400;500;600',
  'Inter Tight': 'wght@500;600',
  Amiri: 'wght@400;700',
  Fraunces: 'wght@600',
  Rubik: 'wght@500;700',
  'DM Sans': 'wght@500;700',
  Figtree: 'wght@500;600',
  'El Messiri': 'wght@600;700',
  Lora: 'wght@500;600',
  'Baloo Bhaijaan 2': 'wght@600;700',
  Almarai: 'wght@400;700;800',
  Nunito: 'wght@600;700;800',
  'Reem Kufi': 'wght@600',
  'Bodoni Moda': 'wght@600',
  'Markazi Text': 'wght@600',
  'Libre Caslon Text': 'wght@400;700',
  Kufam: 'wght@600',
  Italiana: '',
};

/** True for a family the looks system can load (it has an entry in `LOOK_FONT_SPECS`). */
export function isLookFont(family: unknown): family is string {
  return (
    typeof family === 'string' && Object.prototype.hasOwnProperty.call(LOOK_FONT_SPECS, family)
  );
}

/**
 * The faces a look store actually paints, merchant first (Ruling LOOKS-3): a stored
 * `headingFont` / `bodyFont` wins over the look's, but ONLY when it is a family in
 * `LOOK_FONT_SPECS` — anything else (a legacy store's old font kept through a "keep" switch,
 * a typo) is ignored here so the CSS never names a family nothing loads. `latin` follows a
 * merchant heading override (an English heading in the merchant's face, not the look's Latin
 * face); without one it is the look's Latin display family (Ruling LOOKS-7).
 */
export function resolveLookFonts(
  look: LookDefinition,
  theme: { headingFont?: unknown; bodyFont?: unknown } = {}
): { display: string; body: string; latin: string } {
  const { fonts } = look.tokens;
  const display = isLookFont(theme.headingFont) ? theme.headingFont : fonts.display;
  const body = isLookFont(theme.bodyFont) ? theme.bodyFont : fonts.body;
  const latin = display === fonts.display ? fonts.latin : display;
  return { display, body, latin };
}

/**
 * One Google Fonts css2 URL carrying exactly the families this look store paints
 * (`resolveLookFonts`): the look's own, or a merchant override that replaced one.
 */
export function lookFontsHref(
  look: LookDefinition,
  theme: { headingFont?: unknown; bodyFont?: unknown } = {}
): string {
  const fams = [...new Set(Object.values(resolveLookFonts(look, theme)))];
  const q = fams.map(f => {
    const spec = LOOK_FONT_SPECS[f];
    if (spec === undefined) throw new Error(`no font spec for ${f}`);
    return 'family=' + encodeURIComponent(f).replace(/%20/g, '+') + (spec ? ':' + spec : '');
  });
  return `https://fonts.googleapis.com/css2?${q.join('&')}&display=swap`;
}
