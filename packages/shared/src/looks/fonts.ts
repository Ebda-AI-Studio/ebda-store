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

/** One Google Fonts css2 URL carrying exactly this look's families. */
export function lookFontsHref(look: LookDefinition): string {
  const fams = [...new Set(Object.values(look.tokens.fonts))];
  const q = fams.map(f => {
    const spec = LOOK_FONT_SPECS[f];
    if (spec === undefined) throw new Error(`no font spec for ${f}`);
    return 'family=' + encodeURIComponent(f).replace(/%20/g, '+') + (spec ? ':' + spec : '');
  });
  return `https://fonts.googleapis.com/css2?${q.join('&')}&display=swap`;
}
