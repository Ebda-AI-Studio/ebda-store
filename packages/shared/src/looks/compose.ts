import type { StoreTheme, TemplateId } from '../types/store-theme';
import { getTemplateTheme } from '../types/store-theme';
import { hexToHsl as h } from '../utils/color';
import { getLook } from './registry';
import { LOOK_TOKEN_KEYS, type LookDefinition } from './types';

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
    accentForeground: h(t.onPrimary),
    borderColor: h(t.line),
    inputColor: h(t.line),
    ringColor: h(t.primary),
    bgPage: h(t.page),
    bgSectionAlt: h(t.surface),
    headingFont: t.fonts.display,
    bodyFont: t.fonts.body,
    borderRadius: t.radius,
    density: t.density,
    imageRatio: t.imageRatio,
    motion: t.motion,
  };
}

/** Skin theme < look tokens < merchant-stored theme. Unknown/null look = skin + stored only. */
export function composeStoreTheme(i: {
  template: TemplateId;
  look?: string | null;
  theme?: Record<string, unknown> | null;
}): StoreTheme {
  const look = getLook(i.look);
  return {
    ...getTemplateTheme(i.template),
    ...(look ? lookTheme(look) : {}),
    ...((i.theme ?? {}) as Partial<StoreTheme>),
  };
}

/** Look-owned keys the merchant has stored with a value that differs from the look. */
export function overriddenLookKeys(
  theme: Record<string, unknown> | null | undefined,
  look: LookDefinition
): (typeof LOOK_TOKEN_KEYS)[number][] {
  if (!theme) return [];
  const base = lookTheme(look) as Record<string, unknown>;
  return LOOK_TOKEN_KEYS.filter(k => theme[k] !== undefined && theme[k] !== base[k]);
}
