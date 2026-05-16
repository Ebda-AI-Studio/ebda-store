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

export function OutOfStockRibbon({
  inStock = true,
  isRtl = false,
  className = '',
}: OutOfStockRibbonProps) {
  if (inStock) return null;
  return (
    <span
      className={`absolute top-3 start-3 z-10 rounded-md bg-red-600 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.08em] text-white shadow-[0_8px_20px_-8px_rgb(220_38_38_/_0.5)] ${className}`}
    >
      {isRtl ? 'نفدت الكمية' : 'Out Of Stock'}
    </span>
  );
}
