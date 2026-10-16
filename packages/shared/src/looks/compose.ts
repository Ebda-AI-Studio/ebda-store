import type { StoreTheme, TemplateId } from '../types/store-theme';
import { getTemplateTheme } from '../types/store-theme';
import { hexToHsl as h } from '../utils/color';
import { getLook } from './registry';
import { LOOK_OWNED_THEME_KEYS, type LookDefinition } from './types';

/**
 * The StoreTheme keys a look sets. Colour values are bare HSL triplets (the
 * format StoreTheme and `bgPage`/`bgSectionAlt` already use), converted from
 * the look's hex tokens.
 */
export function lookTheme(look: LookDefinition): Partial<StoreTheme> {
  const t = look.tokens;
  return {
    backgroundColor: h(t.page),
    foregroundColor: h(t.ink),
    cardColor: h(t.surface),
    cardForeground: h(t.ink),
    popoverColor: h(t.surface),
    popoverForeground: h(t.ink),
    mutedColor: h(t.surface),
    mutedForeground: h(t.muted),
    secondaryColor: h(t.surface),
    secondaryForeground: h(t.ink),
    primaryColor: h(t.primary),
    primaryForeground: h(t.onPrimary),
    accentColor: h(t.accent),
    accentForeground: h(t.onAccent ?? t.onPrimary),
    borderColor: h(t.line),
    // Inputs take the muted ink, not the hairline (quality bar K-05: boundaries >= 3:1).
    inputColor: h(t.muted),
    ringColor: h(t.primary),
    bgPage: h(t.page),
    bgSectionAlt: h(t.surface),
    headingFont: t.fonts.display,
    bodyFont: t.fonts.body,
    borderRadius: t.radius,
    density: t.density,
    imageRatio: t.imageRatio,
    motion: t.motion,
    // Optional UI tokens: emitted only when the look sets them (absent = skin behaviour).
    ...(t.wordmarkSize ? { wordmarkSize: t.wordmarkSize } : {}),
    ...(t.overPhotoChrome ? { overPhotoChrome: t.overPhotoChrome } : {}),
    ...(t.receiptStyle ? { receiptStyle: t.receiptStyle } : {}),
    ...(t.cardCta ? { cardCta: t.cardCta } : {}),
    ...(t.cardHover ? { cardHover: t.cardHover } : {}),
    ...(t.cardBadge ? { cardBadge: t.cardBadge } : {}),
  };
}

/** Skin theme < look tokens < merchant-stored theme. Unknown/null look = skin + stored only. */
export function composeStoreTheme(i: {
  template: TemplateId;
  look?: string | null;
  theme?: Record<string, unknown> | null;
}): StoreTheme {
  const look = getLook(i.look);
  const stored = (i.theme ?? {}) as Partial<StoreTheme>;
  const out: StoreTheme = {
    ...getTemplateTheme(i.template),
    ...(look ? lookTheme(look) : {}),
    ...stored,
  };
  // Ruling B1-43: form fields draw with --input. On a store with no look, a saved border colour
  // (Branding editor, site settings, an older palette) with no saved input colour keeps the
  // fields on that border, exactly as they drew before the border-input sweep.
  if (!look && stored.borderColor && stored.inputColor === undefined)
    out.inputColor = stored.borderColor;
  return out;
}

/** Look-owned keys the merchant has stored with a value that differs from the look. */
export function overriddenLookKeys(
  theme: Record<string, unknown> | null | undefined,
  look: LookDefinition
): (typeof LOOK_OWNED_THEME_KEYS)[number][] {
  if (!theme) return [];
  const base = lookTheme(look) as Record<string, unknown>;
  return LOOK_OWNED_THEME_KEYS.filter(k => theme[k] !== undefined && theme[k] !== base[k]);
}
