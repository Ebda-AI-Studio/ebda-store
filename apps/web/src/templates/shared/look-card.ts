import type { CardCta, StoreLayoutSettings, StoreTheme } from '@ebda/shared';
import { getLook } from '@ebda/shared';

/**
 * Look tokens that govern the product card (W2b: L-01 CTA, M-03 hover, K-01 chips, L-12 heart).
 *
 * Every helper returns the LEGACY answer when the composed theme carries no token, so a store with
 * no look (and a look that does not declare one) renders exactly as before. Precedence is the one
 * rule of the looks system: merchant > look > skin.
 */

/**
 * The card action a look asks for, or undefined (the skin's CTA system). A merchant who chose a
 * card CTA mode (`productCardDefaults.ctaMode`, "auto" or "viewOnly") keeps it: merchant > look.
 */
export function lookCardCta(
  theme: Pick<StoreTheme, 'cardCta'> | null | undefined,
  layout: Pick<StoreLayoutSettings, 'productCardDefaults'> | null | undefined
): CardCta | undefined {
  if (layout?.productCardDefaults?.ctaMode !== undefined) return undefined;
  return theme?.cardCta;
}

/**
 * Does a card render its action control under this mode?
 * - undefined: yes (the legacy View / Add / Sold-out control).
 * - `none`: never; the card itself is the link to the product page.
 * - `quiet`: only an add for a product that can be bought now and has no options to choose;
 *   a sized product opens its page (the size choice), a sold-out one says so on its photo.
 */
export function lookCtaVisible(
  mode: CardCta | undefined,
  p: { hasVariants: boolean; orderable: boolean }
): boolean {
  if (mode === 'none') return false;
  if (mode === 'quiet') return p.orderable && !p.hasVariants;
  return true;
}

/** The quiet add: an outline in the control token on the look radius, never a filled slab. */
export const QUIET_CARD_CTA_CLS =
  'whitespace-nowrap rounded-[var(--radius)] border border-input bg-transparent px-4 py-2.5 text-sm font-medium text-foreground hover:bg-foreground/5 transition-colors min-h-[44px]';

/** The card hover lift every skin card had (scale + shadow); kept unless a look says `none`. */
export const CARD_HOVER_LIFT_CLS =
  'md:hover:scale-[1.02] md:hover:shadow-[0_20px_40px_-20px_hsl(var(--foreground)/0.18)]';

export function cardHoverCls(theme: Pick<StoreTheme, 'cardHover'> | null | undefined): string {
  return theme?.cardHover === 'none' ? '' : CARD_HOVER_LIFT_CLS;
}

/** Sale / new / custom chips on a look that asks for its accent: look radius, no glow. */
export const LOOK_CHIP_CLS =
  'pointer-events-none absolute z-10 rounded-[var(--radius)] px-2.5 py-1 text-xs font-semibold';
// `--chip-bg` / `--chip-fg` let a look re-derive the sale chip to its own metal or ink (Night souq:
// brass, not a second coral accent, STOP-2 re-audit); unset they are the accent pair as before.
export const LOOK_CHIP_STYLE = {
  backgroundColor: 'hsl(var(--chip-bg, var(--accent)))',
  color: 'hsl(var(--chip-fg, var(--accent-foreground)))',
} as const;

/**
 * VT-b: the NEW chip on a look store is neutral, ink on paper, on every look, so the accent
 * belongs to the sale chip (engagement) only.
 */
export const LOOK_NEW_CHIP_STYLE = {
  backgroundColor: 'hsl(var(--background))',
  color: 'hsl(var(--foreground))',
} as const;

export function lookChip(theme: Pick<StoreTheme, 'cardBadge'> | null | undefined): boolean {
  return theme?.cardBadge === 'accent';
}

/** Fixed ink for a control that sits on a product PHOTO (photos are shot on white, design.md). */
export const OVER_PHOTO_INK = '#141414';

/**
 * The wishlist heart's material on a photo (L-12 / LB-02). Undefined = the legacy disc, whose icon
 * reads the page foreground (invisible on a dark-page look: 1.12:1 on Lookbook). Any store with a
 * look gets at least `soft` (the white disc with FIXED ink), so no look's heart depends on its
 * page colour; `bare` drops the disc for a glyph with a 44px hit area.
 */
export function overPhotoMaterial(
  theme: Pick<StoreTheme, 'overPhotoChrome'> | null | undefined,
  look: string | null | undefined
): 'soft' | 'bare' | undefined {
  return theme?.overPhotoChrome ?? (getLook(look) ? 'soft' : undefined);
}

export function overPhotoHeartCls(material: 'soft' | 'bare', wishlisted: boolean): string {
  // "On" is the filled glyph in the same fixed ink (the svg fills currentColor), never a red
  // that measures 3.7:1 on the card surface.
  const ink = wishlisted
    ? 'text-[rgb(20_20_20)]'
    : 'text-[rgb(20_20_20/0.78)] hover:text-[rgb(20_20_20)]';
  // Audit 2026-11-03 #9: the plate is OPAQUE white with a hairline ring (it was 85-95% white, which read
  // as a grey square over a photo). It keeps the look's own radius (Ruling LB-c).
  // `bare` (Atelier): no disc, but a plate in the look's own radius behind the glyph, so it is
  // >= 3:1 over a dark photo too (a11y P1-8: the plate-less glyph measured 2.38:1).
  return material === 'bare'
    ? `before:absolute before:-inset-1 before:content-[''] absolute top-3 start-3 z-20 inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius)] bg-white ring-1 ring-black/5 transition-colors duration-[var(--duration-base)] cursor-pointer ${ink}`
    : `before:absolute before:-inset-1.5 before:content-[''] absolute top-3 start-3 z-20 inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius)] bg-white shadow-[0_8px_20px_-8px_rgb(20_20_20/0.30)] ring-1 ring-black/5 transition-[background-color,color] duration-[var(--duration-base)] hover:bg-white cursor-pointer ${ink}`;
}

/**
 * The related-products strip heading (T-03, decision (a)): a look's display face is never set under
 * 24px; a store with no look keeps the compact 20px strip heading.
 */
export function relatedHeadingSize(look: string | null | undefined): '24px' | '20px' {
  return getLook(look) ? '24px' : '20px';
}
