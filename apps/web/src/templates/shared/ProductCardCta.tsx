'use client';

import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AddToCartButton, CartIcon, cn } from '@ebda/ui';
import type { StoreTheme } from '@ebda/shared';
import { resolveColor } from '@ebda/shared';
import type { CtaShape, CtaSize } from './card-size';
import { ctaShapeClass, ctaSizeClass, labelShapeClass, oosPlacementClass } from './card-size';
import { avoidReservedCorner, soldOutCorner } from './badge-collision';
import type { CardCta } from '@ebda/shared';
import { lookCtaVisible, QUIET_CARD_CTA_CLS } from './look-card';

/**
 * Shared platform-level CTA used by EVERY theme's ProductCard.
 * Picks between two button shapes per the 2026-05-16 mobile-ui-ship plan
 * (first shipped only on PecannbeeProductCard in 65de277; Ahmad's standing
 * rule 'platform-level fixes go on ALL templates' moved it here so every
 * theme inherits).
 *
 *   hasVariants  → render a "View" button that navigates to the PDP via
 *                  `router.push(viewHref)`. We can't render a real <Link>
 *                  because the entire ProductCard is already wrapped in
 *                  one (nested <a> is invalid HTML), and we can't rely on
 *                  the parent Link click bubbling because each theme's
 *                  quick-add slot wraps in a `<div onClick=preventDefault>`
 *                  to stop cart-button clicks from triggering nav.
 *
 *   !hasVariants → render the existing AddToCartButton (preserves the
 *                  rich loading / added / out-of-stock state machine).
 *
 * Each theme passes `className` to harmonize with its visual language.
 *
 * Task 3 (B1): ctaShape, ctaSize, ctaColor, ctaTextColor, ctaLabelTextEn,
 * ctaLabelTextAr, oosDimColor, theme — all optional, additive.
 */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * FU46 D7: a card narrow enough that the full "Add to cart" label would
 * ellipsize (the 3-col elegant PLP, the ~88px recommendation cards at 320-360)
 * swaps to the existing icon-only cart button instead. Detection is by
 * measurement, not breakpoint: the card width depends on the grid, not the
 * viewport. `needed` remembers the full label's width so the label comes back
 * when the box grows (rotation, resize) without flapping.
 *
 * Assumption behind the way back: the CTA FILLS its parent's content box (no
 * sibling beside it), so "the parent's content width" is the width the label
 * would get. Every card path today renders the CTA alone in its slot. A card
 * that puts a sibling (a wishlist heart, a qty stepper) beside the CTA must
 * subtract that sibling's width from `available`, or the label returns while
 * it still does not fit and the two states flap.
 */
export function useCompactCta() {
  const ref = useRef<HTMLButtonElement | null>(null);
  const needed = useRef(0);
  const [compact, setCompact] = useState(false);

  const evaluate = useCallback(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const cs = getComputedStyle(parent);
    const available =
      parent.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    if (!compact) {
      if (el.scrollWidth > el.clientWidth + 1) {
        needed.current = el.scrollWidth;
        setCompact(true);
      }
    } else if (needed.current > 0 && available >= needed.current + 4) {
      setCompact(false);
    }
  }, [compact]);

  // Layout effect: the swap lands before first paint, so a cramped card never
  // shows the ellipsized label for a frame. (useEffect on the server: no warning.)
  useIsomorphicLayoutEffect(() => {
    evaluate();
    const parent = ref.current?.parentElement;
    let cancelled = false;
    const reevaluate = () => {
      if (!cancelled) evaluate();
    };
    // A webfont that lands after mount changes the label width: measure again.
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    fonts?.ready?.then(reevaluate).catch(() => {});
    fonts?.addEventListener?.('loadingdone', reevaluate);
    const ro =
      parent && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(reevaluate) : null;
    if (parent) ro?.observe(parent);
    return () => {
      cancelled = true;
      fonts?.removeEventListener?.('loadingdone', reevaluate);
      ro?.disconnect();
    };
  }, [evaluate, compact]);

  return { ref, compact };
}

// `sm:px-0` too: tailwind-merge keeps variant-prefixed padding from the pack / ctaSize.
const COMPACT_CTA_CLS = 'mx-auto h-11 min-h-0 w-11 min-w-0 shrink-0 px-0 py-0 sm:px-0';

interface AdaptiveAddButtonProps {
  label: string;
  className?: string;
  style?: React.CSSProperties;
  onClick?: (e: React.MouseEvent) => void;
  disabled?: boolean;
  loading?: boolean;
  /** Show the cart icon beside the label (Pecannbee card); the carousel is text-only. */
  showIcon?: boolean;
  dataZone?: string;
}

/**
 * The raw add-to-cart `<button>` of the Pecannbee card and the shared carousel
 * (they do not go through ProductCardCta). Same fit rule as ProductCardCta:
 * when the label would ellipsize in this box, show the cart icon alone with
 * the label as its accessible name.
 */
export function AdaptiveAddButton({
  label,
  className,
  style,
  onClick,
  disabled,
  loading,
  showIcon,
  dataZone,
}: AdaptiveAddButtonProps) {
  const { ref, compact } = useCompactCta();
  const icon = loading ? (
    <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
  ) : (
    <CartIcon className="h-4 w-4" aria-hidden={true} />
  );
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={compact ? cn(className, COMPACT_CTA_CLS) : className}
      style={style}
      aria-label={compact ? label : undefined}
      data-zone={dataZone}
      data-cta={compact ? 'add-compact' : 'button'}
    >
      {compact ? (
        icon
      ) : (
        <>
          {showIcon ? icon : null}
          {label}
        </>
      )}
    </button>
  );
}

interface ProductCardCtaProps {
  productId: string;
  inStock?: boolean;
  hasVariants?: boolean;
  viewHref?: string;
  quantityInCart?: number;
  isRtl?: boolean;
  onAddToCart?: (productId: string) => Promise<void> | void;
  className?: string;
  labels?: {
    addToCart?: string;
    addedToCart?: string;
    outOfStock?: string;
    adding?: string;
    view?: string;
  };
  variant?: 'default' | 'outline' | 'ghost';
  showQuantityBadge?: boolean;
  /** Task 3 B1 — new customization props (all optional, additive) */
  ctaShape?: CtaShape;
  ctaSize?: CtaSize;
  ctaColor?: string;
  ctaTextColor?: string;
  ctaLabelTextEn?: string;
  ctaLabelTextAr?: string;
  oosDimColor?: string;
  theme?: StoreTheme;
  /**
   * When true, renders the "View" link to the PDP even for no-variant
   * in-stock products — same as the hasVariants path.
   * Driven by productCardDefaults.ctaMode === 'viewOnly'.
   */
  viewOnly?: boolean;
  /**
   * The look's card action (W2b, L-01; `lookCardCta(theme, layout)`): `none` renders nothing,
   * `quiet` only an outline add for a simple buyable product. Undefined = the system above.
   */
  lookCta?: CardCta;
}

export function ProductCardCta({
  productId,
  inStock = true,
  hasVariants = false,
  viewHref,
  quantityInCart = 0,
  isRtl = false,
  onAddToCart,
  className = '',
  labels,
  variant,
  showQuantityBadge = false,
  ctaShape,
  ctaSize,
  ctaColor,
  ctaTextColor,
  ctaLabelTextEn,
  ctaLabelTextAr,
  oosDimColor: _oosDimColor,
  theme,
  viewOnly = false,
  lookCta,
}: ProductCardCtaProps) {
  const router = useRouter();
  const { ref: ctaRef, compact: compactRaw } = useCompactCta();
  // An out-of-stock label must stay words: a disabled cart icon reads as "broken".
  const compact = compactRaw && inStock !== false;

  // Build additive shape + size classes — '' when unset so theme classes win.
  const shapeClass = ctaShapeClass(ctaShape);
  const sizeClass = ctaSizeClass(ctaSize);
  const extraCls = [shapeClass, sizeClass].filter(Boolean).join(' ');

  // Resolve custom colors when provided.
  const resolvedBg = ctaColor && theme ? resolveColor(ctaColor, theme) : undefined;
  const resolvedText = ctaTextColor && theme ? resolveColor(ctaTextColor, theme) : undefined;
  const customStyle: React.CSSProperties = {
    ...(resolvedBg ? { backgroundColor: resolvedBg } : {}),
    ...(resolvedText ? { color: resolvedText } : {}),
  };

  // oosDimColor is an IMAGE overlay (see OosImageDim) — not a CTA background.
  // No CTA-specific oosDim styling here.
  const oosDimStyle: React.CSSProperties = {};

  if (
    !lookCtaVisible(lookCta, { hasVariants: hasVariants || viewOnly, orderable: inStock !== false })
  )
    return null;
  if (lookCta === 'quiet') className = QUIET_CARD_CTA_CLS;

  // viewOnly: force the View link path for no-variant in-stock products too.
  if ((hasVariants || viewOnly) && viewHref) {
    const viewLabel =
      (isRtl ? ctaLabelTextAr : ctaLabelTextEn) ?? labels?.view ?? (isRtl ? 'عرض' : 'View');
    // cn() runs tailwind-merge so the merchant's ctaShape/ctaSize classes
    // (extraCls) override the base button's hardcoded rounded-*/padding/size
    // utilities instead of silently losing the Tailwind source-order battle.
    const finalCls = cn(
      className ||
        'inline-flex w-full items-center justify-center min-h-[44px] rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors px-4 py-2 text-sm font-medium cursor-pointer',
      extraCls
    );
    return (
      <button
        type="button"
        onClick={e => {
          e.preventDefault();
          e.stopPropagation();
          router.push(viewHref);
        }}
        ref={ctaRef}
        aria-label={viewLabel}
        data-cta="view-variants"
        className={finalCls}
        style={customStyle}
      >
        {viewLabel}
      </button>
    );
  }

  // Build labels with optional text overrides.
  const mergedLabels = {
    ...labels,
    ...(ctaLabelTextEn || ctaLabelTextAr
      ? {
          addToCart: (isRtl ? ctaLabelTextAr : ctaLabelTextEn) ?? labels?.addToCart,
          view: (isRtl ? ctaLabelTextAr : ctaLabelTextEn) ?? labels?.view,
        }
      : {}),
  };

  // cn()/tailwind-merge so extraCls (ctaShape/ctaSize) wins over the theme
  // button's hardcoded rounded-*/size utilities.
  const finalClassName = compact ? cn(className, COMPACT_CTA_CLS) : cn(className, extraCls);

  return (
    <AddToCartButton
      ref={ctaRef}
      iconOnly={compact}
      data-cta={compact ? 'add-compact' : undefined}
      productId={productId}
      inStock={inStock}
      quantityInCart={quantityInCart}
      isRtl={isRtl}
      onAddToCart={onAddToCart}
      showQuantityBadge={showQuantityBadge}
      variant={variant}
      labels={mergedLabels}
      className={finalClassName}
      style={{ ...customStyle, ...oosDimStyle }}
    />
  );
}

/**
 * Shared "Out Of Stock" red ribbon for the top-start corner of a
 * ProductCard's image container. Visual match to pecannbee IMG_7988 /
 * IMG_7995. Mounts only when stock=0. RTL-aware via `start-3`.
 *
 * Task 3 B4: when any oosLabel* field is set render a configurable badge
 * instead. When oosLabel===false render nothing. When no oosLabel* fields
 * are set, keep the existing ribbon (full back-compat).
 */
interface OutOfStockRibbonProps {
  inStock?: boolean;
  isRtl?: boolean;
  className?: string;
  /** Task 3 B4 — OOS badge customization (all optional, additive) */
  oosLabel?: boolean;
  oosLabelTextEn?: string;
  oosLabelTextAr?: string;
  oosLabelShape?: CtaShape;
  oosLabelPlacement?: 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';
  oosLabelColor?: string;
  oosLabelTextColor?: string;
  theme?: StoreTheme;
  /**
   * Issue #548 — which LOGICAL top corner(s), if any, an action button
   * (wishlist heart / compare button / remove-from-wishlist button) already
   * occupies on this surface. Same contract as `resolveCardBadges`'
   * `topStartReserved`/`topEndReserved` in `custom-badge.ts` — pass the exact
   * boolean the surface uses to decide whether it renders that button. Both
   * default to false (no reserved corner — byte-identical to today).
   */
  topStartReserved?: boolean;
  topEndReserved?: boolean;
  /** A look store: a flat chip on the look radius, never the rotated sash (taste re-audit P1-2). */
  flat?: boolean;
}

/**
 * Sprint 2 (2026-05-17): upgraded from a small absolute pill to a true
 * diagonal corner RIBBON — the Pecannbee IMG_7995 / IMG_7996 pattern
 * the references all use. Sits across the start-top corner at -45°
 * (RTL flips the rotation), terracotta `--danger` color from the
 * Sprint 1 DESIGN.md. Eye catches it instantly vs the previous pill
 * which competed with the wishlist heart in the same corner.
 *
 * Implementation: outer 88x88 wrapper with overflow-hidden so the
 * banner is clipped to the corner; inner banner is wider than its
 * parent + rotated so its ends bleed off-canvas, giving the clean
 * diagonal edge. The card's `overflow-hidden` on the image wrapper
 * does the final clipping to the card's rounded corner.
 *
 * Task 3 B4: when any oosLabel* customization field is present, renders
 * a configurable badge pill instead of the diagonal ribbon. oosLabel===false
 * suppresses all OOS UI. Falls back to the original ribbon when unset.
 */
/**
 * The shared sold-out label text: the merchant's own OOS label (`productCardDefaults.oosLabelText*`)
 * else the platform default. Used by the card badge below and by every row that lists a product
 * (shop-the-look), so a sold-out piece reads the same everywhere.
 */
export function soldOutLabel(isRtl: boolean, textEn?: string, textAr?: string): string {
  return (isRtl ? textAr : textEn) ?? (isRtl ? 'نفدت الكمية' : 'Sold Out');
}

export function OutOfStockRibbon({
  inStock = true,
  isRtl = false,
  className = '',
  oosLabel,
  oosLabelTextEn,
  oosLabelTextAr,
  oosLabelShape,
  oosLabelPlacement,
  oosLabelColor,
  oosLabelTextColor,
  theme,
  topStartReserved = false,
  topEndReserved = false,
  flat = false,
}: OutOfStockRibbonProps) {
  if (inStock) return null;

  // oosLabel===false → render nothing (merchant explicitly suppressed it).
  if (oosLabel === false) return null;

  // Check if any badge customization field is set.
  const hasBadgeConfig = !!(
    oosLabelTextEn ||
    oosLabelTextAr ||
    oosLabelShape ||
    oosLabelPlacement ||
    oosLabelColor ||
    oosLabelTextColor
  );

  if (hasBadgeConfig) {
    // Configurable badge pill path.
    // 2026-07-10: default EN fallback shortened 'Out of stock' → 'Sold Out'
    // (matches the shorter copy already used on the elegant CTA label) —
    // narrower text keeps the compact pill from growing as wide as the
    // wishlist heart-collision guard below needs to reserve.
    const labelText = soldOutLabel(isRtl, oosLabelTextEn, oosLabelTextAr);

    // Issue #548 — the guard below used to reserve the heart's footprint on
    // EVERY top placement via a symmetric max-width, which only actually
    // clears the heart when the merchant explicitly chose top-end: the
    // default (unset → top-start) is the SAME corner a heart at top-start
    // (PecannbeeProductCard) or a compare button occupies, and a max-width
    // with no matching inset just narrows the pill in place — it still
    // starts under the heart. Fixed the same way `custom-badge.ts` fixes
    // the sale/custom chips: resolve the NAMED placement, then move it off
    // whichever logical top corner is actually reserved on this surface
    // (falling to the bottom, same side, if both top corners are taken).
    const namedPlacement = oosLabelPlacement ?? 'top-start';
    const [namedV, namedH] = namedPlacement.split('-') as ['top' | 'bottom', 'start' | 'end'];
    const avoidedPlacement = avoidReservedCorner<'start' | 'end'>({
      v: namedV,
      h: namedH,
      otherH: namedH === 'start' ? 'end' : 'start',
      hReserved: namedH === 'start' ? topStartReserved : topEndReserved,
      otherHReserved: namedH === 'start' ? topEndReserved : topStartReserved,
    });
    const finalPlacement = `${avoidedPlacement.v}-${avoidedPlacement.h}` as NonNullable<
      OutOfStockRibbonProps['oosLabelPlacement']
    >;
    const placementCls = oosPlacementClass(finalPlacement);
    const shapeCls = labelShapeClass(oosLabelShape);
    // Defaults match the admin ColorField inheritFromToken hints (muted bg /
    // foreground text) so an UNSET color renders the same token the merchant saw
    // in admin — not a hardcoded white. (The ColorField persists undefined when
    // the pick equals the inherited token; the storefront must mirror that token,
    // else "saved black" appeared as white.) Rule 15: token → hsl(var(--key)).
    const bgColor =
      oosLabelColor && theme ? resolveColor(oosLabelColor, theme) : 'hsl(var(--muted))';
    const textColor =
      oosLabelTextColor && theme
        ? resolveColor(oosLabelTextColor, theme)
        : 'hsl(var(--foreground))';

    // Width safety net (2026-07-10, pecannbee live bug, narrowed scope
    // 2026-09-25 per issue #548): even after the corner-avoidance above, an
    // unusually long merchant string on a compact card (110-200px wide)
    // could still stretch far enough to brush the card's OTHER top corner.
    // Truncate as a last resort on any top placement — never a substitute
    // for avoidance, since a plain max-width with no offset does not move
    // the pill out from under a reserved corner (that was the #548 bug).
    // Bottom placements skip the guard — no action button ever lives there.
    const collisionGuardCls =
      avoidedPlacement.v === 'top' ? 'max-w-[calc(100%-3.5rem)] truncate' : '';

    return (
      <span
        className={`pointer-events-none absolute z-10 px-2 py-0.5 text-xs font-bold uppercase tracking-normal shadow-sm ${collisionGuardCls} ${placementCls} ${shapeCls} ${className}`}
        style={{ backgroundColor: bgColor, color: textColor }}
        aria-hidden
      >
        {labelText}
      </span>
    );
  }

  // Default diagonal ribbon. Its corner comes from `soldOutCorner` (X-01): the
  // logical top-start corner, or top-end when the card's heart / compare button
  // sits at top-start (it used to paint UNDER the heart), or a pill on the
  // bottom edge when both top corners hold a button. The sale chip's pin reads
  // the same answer, so the two never share a corner either.
  // theme.oosRibbonColor: the merchant's pick wins. Unset, the band reads the store's own ink
  // and paper tokens (taste re-audit P1-2, Ahmad 2026-10-16: Ebda has no orange). It used to
  // default to a fixed terracotta (hue 15, #873B22), which sat in no store's palette.
  const ribbonBg =
    (theme?.oosRibbonColor && theme && resolveColor(theme.oosRibbonColor, theme)) ??
    'hsl(var(--foreground))';
  const ribbonInk = theme?.oosRibbonColor ? '#ffffff' : 'hsl(var(--background))';
  const label = isRtl ? 'نفدت الكمية' : 'Sold out';
  // A look store: a flat chip on the look radius in the band's corner, never a rotated sash.
  if (flat) {
    const c = soldOutCorner({ topStartReserved, topEndReserved });
    return (
      <span
        className={`pointer-events-none absolute z-10 rounded-[var(--radius)] px-2.5 py-1 text-xs font-semibold ${
          c.v === 'bottom'
            ? oosPlacementClass('bottom-start')
            : `top-3 ${c.h === 'start' ? 'start-3' : 'end-3'}`
        } ${className}`}
        style={{ backgroundColor: ribbonBg, color: ribbonInk }}
        data-oos-corner={c.v === 'bottom' ? 'bottom-start' : `top-${c.h}`}
        aria-hidden
      >
        {label}
      </span>
    );
  }
  const corner = soldOutCorner({ topStartReserved, topEndReserved });
  if (corner.v === 'bottom') {
    return (
      <span
        className={`pointer-events-none absolute z-10 px-2 py-0.5 text-xs font-bold uppercase tracking-normal shadow-sm ${oosPlacementClass('bottom-start')} ${className}`}
        style={{ backgroundColor: ribbonBg, color: ribbonInk }}
        data-oos-corner="bottom-start"
        aria-hidden
      >
        {label}
      </span>
    );
  }
  // The band leans out of its corner: -45deg on the physical LEFT corner, +45deg
  // on the right (start is the right corner in Arabic).
  const physicalLeft = (corner.h === 'start') !== isRtl;
  const rotation = physicalLeft ? -45 : 45;
  return (
    <div
      className={`pointer-events-none absolute top-0 ${corner.h === 'start' ? 'start-0' : 'end-0'} z-10 h-[88px] w-[88px] overflow-hidden ${className}`}
      data-oos-corner={`top-${corner.h}`}
      aria-hidden
    >
      <span
        className={`absolute top-[18px] ${corner.h === 'start' ? 'start-[-34px]' : 'end-[-34px]'} w-[160px] py-1 text-center text-xs font-bold uppercase tracking-wider shadow-md`}
        style={{
          backgroundColor: ribbonBg,
          color: ribbonInk,
          transform: `rotate(${rotation}deg)`,
        }}
      >
        {label}
      </span>
    </div>
  );
}

/**
 * Out-of-stock IMAGE overlay tint. Render INSIDE a card's (relative) image
 * container. When the product isn't orderable AND the merchant set an
 * `oosDimColor`, paints a semi-transparent tint over the image — matching the
 * admin control's description ("overlay tint applied to the card image when out
 * of stock"). Returns null otherwise (zero change for stores that don't set it).
 */
export function OosImageDim({
  orderable,
  oosDimColor,
  theme,
}: {
  orderable: boolean;
  oosDimColor?: string;
  theme?: StoreTheme;
}) {
  if (orderable || !oosDimColor || !theme) return null;
  const tint = resolveColor(oosDimColor, theme);
  if (!tint) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-[5]"
      style={{ backgroundColor: tint, opacity: 0.45 }}
      aria-hidden
    />
  );
}

/**
 * Sprint 2: helper that decides whether a product should display the
 * NEW badge. Returns true when the merchant explicitly flagged it
 * (`product.isNew === true`) OR when the product was created within
 * the last `NEW_PRODUCT_WINDOW_DAYS` (default 14). Auto-rotation
 * surfaces fresh inventory without merchant intervention.
 *
 * `createdAt` may be absent on synthetic test fixtures — when missing
 * we fall back to the explicit flag only (no auto-rotation), which
 * is the conservative behavior.
 */
const NEW_PRODUCT_WINDOW_DAYS = 14;

export function isProductNew(
  product: {
    isNew?: boolean;
    createdAt?: string | Date | null;
  },
  /** The render clock (`useRenderNow()`), never a fresh read of the time (hydration-safe). */
  now: number
): boolean {
  if (product.isNew === true) return true;
  if (!product.createdAt) return false;
  const created =
    product.createdAt instanceof Date ? product.createdAt : new Date(product.createdAt);
  if (Number.isNaN(created.getTime())) return false;
  const ageMs = now - created.getTime();
  return ageMs < NEW_PRODUCT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}
