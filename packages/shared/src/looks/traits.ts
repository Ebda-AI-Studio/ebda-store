import type { StoreTheme } from '../types/store-theme';
import { getLook } from './registry';
import { LOOK_FONT_SPECS } from './fonts';
import { contrastRatio } from '../utils/color';

/** True when the family ships a 700 or heavier weight (`LOOK_FONT_SPECS`; '' = a single-weight face). */
function shipsBold(family: string): boolean {
  const spec = LOOK_FONT_SPECS[family] ?? '';
  return /(?:^|[;=])[789]00(?:$|;)/.test(spec);
}

/**
 * What a look decides for a trait the merchant may override (TEMPLATES-MOCK-2/-3). The editor shows this value
 * until the merchant picks one of their own (the stored key is absent), so "the look's default" is always visible
 * and a reset returns to it. `undefined` = the look has no opinion (the skin's own behaviour; the editor then
 * shows "same as the look"). Precedence everywhere else is merchant > look > skin.
 */
export function traitDefault(key: string, lookId?: string | null): string | boolean | undefined {
  switch (key) {
    case 'headerWordmark':
      return 'lockup';
    case 'tabBar':
      return 'inner';
    case 'headingWeight': {
      // The mock's bold display headings, except on a single-weight display face (Lalezar, Kufam...) where
      // "bold" would be a synthesised smear: those stay regular.
      const look = getLook(lookId);
      if (!look) return undefined;
      return shipsBold(look.tokens.fonts.display) ? 'bold' : 'regular';
    }
    case 'priceColour': {
      // Accent prices only on a light-page look whose accent reads (>= 4.5:1) on the page and the surface. On a
      // dark-page look the sections re-scope their own surface (axe: 1.2:1 on qamar.lookbook, jasmine.apothecary,
      // lamma.notebook), so those keep the text colour until the merchant picks accent.
      const look = getLook(lookId);
      if (!look) return undefined;
      const { page, surface, accent } = look.tokens;
      const light = contrastRatio(page, '#000000') > 10;
      return light && contrastRatio(page, accent) >= 4.5 && contrastRatio(surface, accent) >= 4.5
        ? 'accent'
        : 'text';
    }
    case 'cardHeart':
    case 'cardSwatches':
    case 'cardTags':
      return getLook(lookId) ? 'off' : undefined;
    case 'gridGutter':
      // Only the Atelier mock runs 3px gutters; the other mocks sit on the old 10-12px gaps ('regular').
      return getLook(lookId) ? (lookId === 'qamar.atelier' ? 'tight' : 'regular') : undefined;
    case 'heroRatio':
      return undefined; // the look's own mock ratio; the editor shows "same as the look"
    default:
      return undefined;
  }
}

/** Trait key -> the `<body>` data attribute globals.css reads (one place: layout.tsx spreads `lookTraitAttrs`). */
export const TRAIT_ATTRS = {
  headingWeight: 'data-heading-weight',
  priceColour: 'data-price-colour',
  cardHeart: 'data-card-heart',
  cardSwatches: 'data-card-swatches',
  cardTags: 'data-card-tags',
  gridGutter: 'data-grid-gutter',
} as const;

/** The look accent reaches 4.5:1 on the page and the card (when the theme carries those colours; else assumed fine). */
export function accentPriceReads(theme: Partial<StoreTheme> | null | undefined): boolean {
  const t = theme;
  if (!t?.accentColor || !t.backgroundColor || !t.cardColor) return true;
  return (
    contrastRatio(t.backgroundColor, t.accentColor) >= 4.5 &&
    contrastRatio(t.cardColor, t.accentColor) >= 4.5
  );
}

/**
 * The `<body>` data attributes of a look store's mock traits: merchant value, else the look's default.
 * Empty for a store with no look (legacy stores render byte-for-byte as before). Pure.
 */
export function lookTraitAttrs(
  theme: Partial<StoreTheme> | null | undefined,
  lookId: string | null | undefined
): Record<string, string> {
  if (!getLook(lookId)) return {};
  const out: Record<string, string> = {};
  for (const [key, attr] of Object.entries(TRAIT_ATTRS)) {
    const v =
      (theme as Record<string, unknown> | null | undefined)?.[key] ?? traitDefault(key, lookId);
    if (key === 'priceColour' && v === 'accent' && !accentPriceReads(theme)) continue;
    if (typeof v === 'string') out[attr] = v;
  }
  return out;
}
