/**
 * Shared corner-collision avoidance for every absolutely-positioned card
 * badge — the discount chip, the custom (merchant-authored) chip, and the
 * configurable out-of-stock pill. One algorithm, reused by `custom-badge.ts`
 * (which works in PHYSICAL left/right corners) and `ProductCardCta.tsx`'s
 * `OutOfStockRibbon` (which works in LOGICAL start/end corners) — see
 * CLAUDE.md "Platform-level fixes" and the 2026-09-25 heart/badge collision
 * fix (issues #1609, #1611, #548).
 *
 * Ownership: the wishlist heart stays exactly where each theme already
 * renders it (Ahmad's decision — option (a) in the issue triage). Every
 * badge instead avoids whatever corner is occupied by an action button
 * (the wishlist heart, the compare button, or the remove-from-wishlist
 * button on the wishlist page) — see `avoidReservedCorner` below — and, for
 * the discount/custom chips, ALSO avoids the bottom-band CTA / quick-add
 * overlay every card renders (issues #1609, #1611) — see the `bottomTier`
 * helpers in `custom-badge.ts`.
 *
 * Every one of those action buttons is a small fixed-size circle that
 * ALWAYS sits on the TOP edge of the card image — never the bottom — so
 * collision avoidance only ever needs to reason about the top edge: a badge
 * resolving to the SAME top corner as a reserved action button moves to the
 * OTHER top corner; if BOTH top corners are occupied (a compare button AND
 * a wishlist heart both showing on the same card), it drops to the bottom
 * edge, keeping its original horizontal side.
 */

export type CornerV = 'top' | 'bottom';

export interface AvoidReservedCornerInput<H extends string> {
  v: CornerV;
  h: H;
  /** The other horizontal value `H` can take (e.g. h='left' -> otherH='right'). */
  otherH: H;
  /** Is the `h` side of the TOP edge occupied by an action button? */
  hReserved: boolean;
  /** Is the `otherH` side of the TOP edge occupied by an action button? */
  otherHReserved: boolean;
}

/**
 * Resolve a badge's corner away from a reserved top-edge action button.
 * Bottom corners are returned unchanged — no action button ever renders on
 * the bottom edge, so there is nothing there to avoid.
 */
export function avoidReservedCorner<H extends string>({
  v,
  h,
  otherH,
  hReserved,
  otherHReserved,
}: AvoidReservedCornerInput<H>): { v: CornerV; h: H } {
  if (v !== 'top' || !hReserved) return { v, h };
  return otherHReserved ? { v: 'bottom', h } : { v: 'top', h: otherH };
}

/**
 * X-01 (Lookbook/Vitrine taste gate 2026-10-15): the sold-out marker's corner —
 * ONE answer for the ribbon itself (`OutOfStockRibbon`) and for the sale chip's
 * pin (`pinDefaultDiscountBadge`), so the two can plan around each other.
 *
 * The marker's home is the logical top-START corner. A card whose wishlist heart
 * (or compare / remove button) sits there used to paint the ribbon UNDER the
 * heart; it now moves to top-END, and to the bottom edge when both top corners
 * hold a button.
 */
export function soldOutCorner({
  topStartReserved = false,
  topEndReserved = false,
}: {
  topStartReserved?: boolean;
  topEndReserved?: boolean;
}): { v: CornerV; h: 'start' | 'end' } {
  return avoidReservedCorner<'start' | 'end'>({
    v: 'top',
    h: 'start',
    otherH: 'end',
    hReserved: topStartReserved,
    otherHReserved: topEndReserved,
  });
}

/**
 * The NEW chip's corner (W2b, X-01 class; IA-08 W4): ONE fixed corner, top-end (the shared card's
 * heart owns top-start), so its position means something. When the sale chip also sits at top-end,
 * NEW stacks directly under it (sale over new) instead of jumping to another corner.
 */
export function newBadgeCornerCls(reserved: {
  topStartReserved?: boolean;
  topEndReserved?: boolean;
}): string {
  return reserved.topEndReserved ? 'top-12 end-3' : 'top-3 end-3';
}
