'use client';

import { useRouter } from 'next/navigation';
import { AddToCartButton } from '@force/ui';

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
}: ProductCardCtaProps) {
  const router = useRouter();

  if (hasVariants && viewHref) {
    const viewLabel = labels?.view ?? (isRtl ? 'عرض' : 'View');
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
        className={
          className ||
          'inline-flex w-full items-center justify-center min-h-[44px] rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors px-4 py-2 text-sm font-medium cursor-pointer'
        }
      >
        {viewLabel}
      </button>
    );
  }

  return (
    <AddToCartButton
      productId={productId}
      inStock={inStock}
      quantityInCart={quantityInCart}
      isRtl={isRtl}
      onAddToCart={onAddToCart}
      showQuantityBadge={showQuantityBadge}
      variant={variant}
      labels={labels}
      className={className}
    />
  );
}

/**
 * Shared "Out Of Stock" red ribbon for the top-start corner of a
 * ProductCard's image container. Visual match to pecannbee IMG_7988 /
 * IMG_7995. Mounts only when stock=0. RTL-aware via `start-3`.
 */
interface OutOfStockRibbonProps {
  inStock?: boolean;
  isRtl?: boolean;
  className?: string;
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
 */
export function OutOfStockRibbon({
  inStock = true,
  isRtl = false,
  className = '',
}: OutOfStockRibbonProps) {
  if (inStock) return null;
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
