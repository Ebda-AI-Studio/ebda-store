'use client';

import type React from 'react';
import { useRouter } from 'next/navigation';
import { AddToCartButton, cn } from '@force/ui';
import type { StoreTheme } from '@force/shared';
import { resolveColor } from '@force/shared';
import type { CtaShape, CtaSize } from './card-size';
import { ctaShapeClass, ctaSizeClass, labelShapeClass, oosPlacementClass } from './card-size';

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
}: ProductCardCtaProps) {
  const router = useRouter();

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
  const finalClassName = cn(className, extraCls);

  return (
    <AddToCartButton
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
    const labelText =
      (isRtl ? oosLabelTextAr : oosLabelTextEn) ?? (isRtl ? 'نفدت الكمية' : 'Sold Out');
    const placementCls = oosPlacementClass(oosLabelPlacement);
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

    // Wishlist-heart collision guard (2026-07-10, pecannbee live bug): the
    // heart button is a fixed 40px circle inset ~12px from a TOP corner on
    // every card that has one (PecannbeeProductCard / elegant / modern). On
    // compact cards (110-200px wide) a wide EN badge placed in the corner
    // OPPOSITE the heart can still physically reach into the heart's
    // footprint and get clipped behind it — confirmed live: 'OUT OF STOCK'
    // (~100px) overlapped the heart by ~12px while the shorter Arabic
    // equivalent (~68px) cleared it by ~20px. Reserve the heart's footprint
    // on any top-row placement so the pill can never grow into it; truncate
    // as a last resort for a merchant's very long custom text. Bottom
    // placements skip the guard — the heart never lives there.
    const isTopPlacement = !oosLabelPlacement || oosLabelPlacement.startsWith('top');
    const collisionGuardCls = isTopPlacement ? 'max-w-[calc(100%-3.5rem)] truncate' : '';

    return (
      <span
        className={`pointer-events-none absolute z-10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-normal shadow-sm ${collisionGuardCls} ${placementCls} ${shapeCls} ${className}`}
        style={{ backgroundColor: bgColor, color: textColor }}
        aria-hidden
      >
        {labelText}
      </span>
    );
  }

  // Default diagonal ribbon (full back-compat).
  // RTL: corner ribbon flips to start-side (which is visually the
  // right edge of the card). The -45deg rotation also flips sign so
  // the text reads correctly from the corner outward.
  const rotation = isRtl ? 45 : -45;
  return (
    <div
      className={`pointer-events-none absolute top-0 start-0 z-10 h-[88px] w-[88px] overflow-hidden ${className}`}
      aria-hidden
    >
      <span
        className="absolute top-[18px] start-[-34px] w-[160px] py-1 text-center text-[10px] font-bold uppercase tracking-wider text-white shadow-md"
        style={{
          backgroundColor: 'hsl(15 60% 33%)',
          transform: `rotate(${rotation}deg)`,
        }}
      >
        {isRtl ? 'نفدت الكمية' : 'Out of Stock'}
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

export function isProductNew(product: {
  isNew?: boolean;
  createdAt?: string | Date | null;
}): boolean {
  if (product.isNew === true) return true;
  if (!product.createdAt) return false;
  const created =
    product.createdAt instanceof Date ? product.createdAt : new Date(product.createdAt);
  if (Number.isNaN(created.getTime())) return false;
  const ageMs = Date.now() - created.getTime();
  return ageMs < NEW_PRODUCT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}
