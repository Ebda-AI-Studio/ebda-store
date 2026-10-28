import type { StoreTheme, TemplateId } from '../types/store-theme';
import { getTemplateTheme } from '../types/store-theme';
import { boundaryColorFloor, hexToHsl as h } from '../utils/color';
import { getLook } from './registry';
import { lockupFor, type Lockup } from './lockup';
import type { TabBarMode } from './types';
import {
  LOOK_OWNED_THEME_KEYS,
  type HeaderLogoPlacement,
  type HeaderSearchPlacement,
  type LookDefinition,
} from './types';

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
  // Taste re-audit (no-look regression): `--input` draws every interactive boundary (VT-05),
  // so it must itself read against the page, >= 3:1, whatever the skin or the saved border was
  // (#E5E7EB chips on white measured 1.24:1). Hue kept, lightness moved; --border untouched.
  if (out.inputColor && out.backgroundColor)
    out.inputColor = boundaryColorFloor(out.inputColor, out.backgroundColor);
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

/**
 * The header chrome a skin draws: the merchant's override (`theme.headerLogoPlacement` /
 * `headerSearch`) over the look's `chrome.header` over `fallback` (the skin's own default).
 * Precedence merchant > look > skin, like the colour tokens (Ruling EP-4). Pure; clearing the
 * override (a `null` in the draft deletes the key) falls back to the look.
 */
export function resolveHeaderChrome(
  theme: Pick<StoreTheme, 'headerLogoPlacement' | 'headerSearch'> | null | undefined,
  lookHeader: { logoPlacement?: HeaderLogoPlacement; search?: HeaderSearchPlacement } | undefined,
  fallback: { logoPlacement: HeaderLogoPlacement; search: HeaderSearchPlacement } = {
    logoPlacement: 'start',
    search: 'icon',
  }
): { logoPlacement: HeaderLogoPlacement; search: HeaderSearchPlacement } {
  return {
    logoPlacement:
      theme?.headerLogoPlacement ?? lookHeader?.logoPlacement ?? fallback.logoPlacement,
    search: theme?.headerSearch ?? lookHeader?.search ?? fallback.search,
  };
}

/**
 * The designed wordmark lockup a header draws for a store WITHOUT an uploaded logo (the header itself checks the
 * logo): the look's lockup unless the merchant chose the plain name (`theme.headerWordmark === 'plain'`).
 * Unset = lockup (TEMPLATES-MOCK-1/-3). Pure; clearing the override falls back to the lockup.
 */
export function resolveLockup(
  theme: Pick<StoreTheme, 'headerWordmark'> | null | undefined,
  look?: string | null,
  template?: string | null
): Lockup | null {
  if (theme?.headerWordmark === 'plain') return null;
  return lockupFor(look, template);
}

/**
 * The phone tab bar mode for a store (TEMPLATES-MOCK-5): merchant > look default (`inner`: no bar on the home
 * page, the header bag is the cart) > legacy store with no look (`always`, unchanged). Pure.
 */
export function resolveTabBar(
  theme: Pick<StoreTheme, 'tabBar'> | null | undefined,
  look?: string | null
): TabBarMode {
  if (theme?.tabBar) return theme.tabBar;
  return getLook(look) ? 'inner' : 'always';
}
