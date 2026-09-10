import type { StoreTheme } from '@force/shared';
import { resolveColor } from '@force/shared';
import { DISCOUNT_BADGE_DEFAULT_POSITION, type DiscountBadgePosition } from './discount-badge';

/**
 * Custom (merchant-authored) product badge — the free-text chip a merchant
 * types per product (`Product.badgeLabel` / `badgeLabelAr`), rendered in the
 * same visual language as the computed discount badge.
 *
 * This file is the SINGLE place that decides:
 *   - what text the badge shows for the current locale,
 *   - which physical corner it occupies,
 *   - what color it is,
 *   - and — the part that matters — whether it and the discount badge are
 *     both allowed to render (the runtime mutex).
 *
 * All nine surfaces (the eight product-card render paths + the PDP) call
 * `resolveCardBadges` and render from its answer. A second copy of the mutex
 * is a second answer, and the storefront would show two chips stacked on one
 * corner on whichever surface drifted.
 *
 * Written to mirror `discount-badge.ts` deliberately — same corner union,
 * same PHYSICAL (non-mirroring) placement semantics, same
 * `resolveColor`-with-token-fallback contract. It is a sibling system, not a
 * new one.
 */

/** Same four physical corners as the discount badge. */
export type CustomBadgePosition = DiscountBadgePosition;

/**
 * Corner used when the merchant has not chosen one.
 *
 * Deliberately NOT the discount badge's 'bottom-left' default: a store that
 * configures neither badge must get them in two DIFFERENT corners, so the
 * out-of-the-box experience is "both visible", not "one suppressed by the
 * mutex below". Bottom-right is also the only corner free of the platform's
 * own overlays in both reading directions — the OOS ribbon, the NEW chip and
 * the BrandPill all sit at the LOGICAL top-start (physical top-left in LTR,
 * physical top-right in RTL), and the wishlist heart shares that corner.
 */
export const CUSTOM_BADGE_DEFAULT_POSITION: CustomBadgePosition = 'bottom-right';

/**
 * Map the merchant's chosen custom-badge corner to Tailwind PHYSICAL position
 * classes (`left-*` / `right-*` / `top-*` / `bottom-*`) — NOT logical
 * `start-*` / `end-*`.
 *
 * Identical rule to `getDiscountBadgePosition`: "bottom-right" means the
 * physical bottom-right corner on an English store AND on an Arabic one. The
 * badge's TEXT mirrors with the locale (Arabic label in the Arabic
 * storefront, and the surrounding page direction lays it out RTL); its
 * PLACEMENT does not, because a merchant who put the chip bottom-right chose
 * a spot in the photo, not a spot in the sentence.
 *
 * `isRtl` is accepted for signature symmetry with the rest of the placement
 * helpers and is intentionally NOT used to flip the corner — that is the
 * whole point of this helper existing.
 */
export function getCustomBadgePosition(
  position: CustomBadgePosition | undefined,
  isRtl?: boolean,
  stacked = false
): string {
  void isRtl;
  // Class names are written out in full on both branches: Tailwind scans source
  // text, so a composed `top-${inset}` would generate no rule at all and the
  // chip would fall back to static flow in the middle of the card.
  switch (position) {
    case 'top-left':
      return stacked ? 'top-12 left-3' : 'top-3 left-3';
    case 'top-right':
      return stacked ? 'top-12 right-3' : 'top-3 right-3';
    case 'bottom-left':
      return stacked ? 'bottom-12 left-3' : 'bottom-3 left-3';
    case 'bottom-right':
    default:
      return stacked ? 'bottom-12 right-3' : 'bottom-3 right-3';
  }
}

/** Which horizontal edge a corner sits on — the axis the two chips share. */
function edgeOf(position: CustomBadgePosition): 'top' | 'bottom' {
  return position.startsWith('top') ? 'top' : 'bottom';
}

/**
 * Resolve the merchant's custom-badge color (token:* or hex) via
 * `resolveColor`. Falls back to the platform's primary CSS variable when
 * unset or when no theme is available — CLAUDE.md rule 15: token color
 * resolution must fall back to `hsl(var(--<key>))`, never silently drop the
 * merchant's intent or render unstyled.
 *
 * Primary (not destructive/red like the discount badge) because this chip is
 * a merchant promotion, not a price cut — it should read as the brand, and it
 * must not be mistaken for a sale badge when both are on the card.
 */
export function getCustomBadgeColor(color: string | undefined, theme?: StoreTheme): string {
  const resolved = color && theme ? resolveColor(color, theme) : undefined;
  return resolved ?? 'hsl(var(--primary))';
}

/** Minimal product shape the custom badge needs. */
export interface CustomBadgeProductLike {
  badgeLabel?: string | null;
  badgeLabelAr?: string | null;
}

/**
 * The label to show for the current locale, or null when the merchant has not
 * set one.
 *
 * Locale rule: prefer the current language's field, fall back to the other.
 * A merchant who fills only the Arabic box still gets a badge on the English
 * storefront (and vice versa) — the alternative, a chip that silently
 * disappears in one language, is the bilingual bug this platform exists to
 * avoid. This is merchant DATA, not UI copy, so there is no
 * LanguageContext entry for it and nothing to translate at build time.
 *
 * Trims, and treats a whitespace-only value as absent — the API trims on
 * write too, but a legacy row or a direct DB edit must not be able to render
 * an empty chip.
 */
export function getCustomBadgeText(product: CustomBadgeProductLike, isRtl: boolean): string | null {
  const en = product.badgeLabel?.trim() || null;
  const ar = product.badgeLabelAr?.trim() || null;
  return (isRtl ? (ar ?? en) : (en ?? ar)) ?? null;
}

export interface ResolveCardBadgesInput {
  product: CustomBadgeProductLike;
  isRtl: boolean;
  /**
   * Backorder-aware orderable signal, exactly as every card already computes
   * it (`product.inStock !== false || product.acceptsBackorder === true`).
   */
  orderable: boolean;
  /** `productCardDefaults.customBadge.position`, unresolved. */
  customPosition?: CustomBadgePosition;
  /** `productCardDefaults.discountBadge.position`, unresolved. */
  discountPosition?: DiscountBadgePosition;
  /**
   * Whether this card will ACTUALLY render a discount chip. Pass the SAME
   * expression the surface renders the chip on — several gate it on their own
   * `hasSale`/`onSale` as well as on the badge text, and passing only the text
   * would lift the custom chip clear of a discount chip that never appears.
   * Two chips compete for pixels only when both are on screen, so a card with
   * a label and no sale must keep its badge in the corner the merchant chose.
   */
  discountVisible?: boolean;
  /**
   * Whether this surface renders the discount badge as an absolutely
   * positioned corner chip. False on the `minimal` theme, whose discount
   * indicator is inline text under the price with no corner at all, and on
   * the PDP, where both badges sit in a flex row of `<Badge>`s. On those
   * surfaces the two can never collide, so the corner arm of the mutex must
   * not fire and steal the discount badge. Defaults to true.
   */
  discountOccupiesCorner?: boolean;
}

export interface ResolvedCardBadges {
  /** Text to render in the custom chip, or null to render nothing. */
  customBadgeText: string | null;
  /**
   * Whether the mutex PERMITS the discount badge. Callers still AND this with
   * their own existing sale condition — this flag only ever takes the badge
   * away, it never forces one on.
   */
  discountBadgeAllowed: boolean;
  /**
   * Position classes for the custom chip, INCLUDING any stacking offset.
   * Callers must render from this rather than calling
   * `getCustomBadgePosition` themselves — the offset is only knowable here,
   * where both badges' corners are in scope.
   */
  customBadgePositionCls: string;
}

/**
 * The badge mutex. One deterministic rule set, one implementation.
 *
 * CLAUDE.md UI/UX rule 1: sister systems are a RUNTIME MUTEX, not a merchant
 * decision — the precedent is `SectionDivider`, which returns null when
 * `backgroundPreset !== 'none'` rather than asking the merchant to avoid the
 * clash. The three rules, in order:
 *
 *   1. NO LABEL → nothing changes. `customBadgeText` is null and
 *      `discountBadgeAllowed` is true, so every surface renders exactly what
 *      it rendered before this feature existed. This is the additive
 *      contract, and it is the reason the feature needs no enable-toggle:
 *      an empty label already means off.
 *
 *   2. NOT ORDERABLE → the custom badge is suppressed. Out-of-stock is a hard
 *      state signal that must not compete with a promotion, and an "Offer"
 *      chip on something nobody can buy is a promise the store cannot keep.
 *      The discount badge is deliberately NOT suppressed here — it is factual
 *      pricing information and has shown in both stock states since the 2026
 *      "BUG 2" fix; changing that would be a regression, not a rule.
 *      This rule also collapses the three-way case (label + discount + OOS)
 *      to today's exact rendering, which is why the three-way combination has
 *      no fourth rule of its own.
 *
 *   3. SAME CORNER → the custom badge wins, the discount badge yields. The
 *      merchant TYPED the custom label; the discount badge is derived from
 *      the pricing maths. When an explicit act and a derived one want the
 *      same pixels, the explicit one wins — same direction as the
 *      SectionDivider precedent, where the deliberate background choice
 *      suppresses the automatic divider. Different corners → both render, so
 *      a merchant who wants both simply moves one, and the default corners
 *      (bottom-right vs bottom-left) already differ.
 *
 * What this deliberately does NOT do: it never stacks two chips on one
 * corner, and it never asks the merchant to resolve the clash.
 */
export function resolveCardBadges({
  product,
  isRtl,
  orderable,
  customPosition,
  discountPosition,
  discountOccupiesCorner = true,
  discountVisible = false,
}: ResolveCardBadgesInput): ResolvedCardBadges {
  const label = getCustomBadgeText(product, isRtl);

  // Rule 2 — stock state outranks promotion.
  const customBadgeText = orderable ? label : null;

  // Rules 3 and 4 compare RESOLVED corners, so an unset position and its
  // explicit equivalent count as the same corner.
  const resolvedCustom = customPosition ?? CUSTOM_BADGE_DEFAULT_POSITION;
  const resolvedDiscount = discountPosition ?? DISCOUNT_BADGE_DEFAULT_POSITION;
  const sameCorner = resolvedCustom === resolvedDiscount;

  const discountBadgeAllowed = !(customBadgeText && discountOccupiesCorner && sameCorner);

  // Rule 4 — SAME EDGE, DIFFERENT CORNERS: stack, don't collide.
  //
  // Rule 3 only fires when the two corners are EQUAL, which left the DEFAULT
  // configuration — discount bottom-left, custom bottom-right — rendering both
  // chips into one horizontal band and trusting the card to be wide enough to
  // hold them. It is not. Both are absolutely positioned with the same z-index,
  // so they overlap and the later one in the DOM paints over the other.
  //
  // Measured in a browser on a 5-across grid (image ~134px wide): a 5-character
  // label overlapped the discount chip by 6px, and an 18-character label — well
  // inside the column's 32-char limit — covered it COMPLETELY (55x24px, the
  // whole chip). The custom badge is merchant free text, so its width is not
  // bounded by anything the layout knows.
  //
  // Suppressing one of them is the wrong trade: the discount chip is factual
  // pricing (rule 2 keeps it even when out of stock, deliberately), and the
  // label is what the merchant paid attention to. Capping the width is also
  // wrong — the only cap that guarantees a fit is narrow enough to truncate
  // "-25%" into nonsense. So move the custom chip UP one row instead: both stay
  // whole, both stay in their chosen horizontal corner, and no width can make
  // them meet. Different edges (top vs bottom) never shared a band, so they are
  // untouched.
  // No `!sameCorner` term: when the corners match, rule 3 has already cleared
  // `discountBadgeAllowed`, so `bothRender` is false and the same-corner case
  // can never reach here. Mutation testing confirmed the clause was dead — it
  // is left out rather than kept as reassurance no test can hold to account.
  const sameEdge = edgeOf(resolvedCustom) === edgeOf(resolvedDiscount);
  const bothRender =
    Boolean(customBadgeText) && discountVisible && discountBadgeAllowed && discountOccupiesCorner;
  const stacked = bothRender && sameEdge;

  return {
    customBadgeText,
    discountBadgeAllowed,
    customBadgePositionCls: getCustomBadgePosition(resolvedCustom, isRtl, stacked),
  };
}
