'use client';

import ProductCard from './ProductCard';
import type { ProductGridProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { cn } from '@force/ui';
import { NoProductsIcon } from '../shared/icons';

import { REGION } from '@force/shared';
/**
 * Modern Template - Product Grid
 *
 * Renders a responsive grid of ProductCards with:
 * - Responsive column layout (2 mobile → 3 tablet → 4 desktop)
 * - CSS-only staggered fade-in (animation-delay derived from `--i` per card)
 * - Empty state handling
 * - Cart quantity tracking per product
 */
export default function ModernProductGrid({
  products,
  isRtl: isRtlProp,
  currency = REGION.currency,
  columns = 4,
  cartQuantities = {},
  onAddToCart,
  onAddToWishlist,
  urlPrefix = '',

  compareIds,

  onToggleCompare,

  onRemoveFromWishlist,
}: ProductGridProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;

  const gridCols: Record<2 | 3 | 4, string> = {
    2: 'grid-cols-2',
    3: 'grid-cols-2 md:grid-cols-3',
    4: 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4',
  };

  if (products.length === 0) {
    return (
      <div
        className="py-20 text-center"
        role="status"
        aria-label={isRtl ? 'لا توجد منتجات' : 'No products found'}
      >
        <div className="w-20 h-20 mx-auto mb-5 rounded-full bg-muted flex items-center justify-center text-muted-foreground/50">
          <NoProductsIcon className="w-9 h-9" />
        </div>
        <h3 className="text-base font-semibold text-foreground mb-1.5">
          {isRtl ? 'لا توجد منتجات' : 'No products found'}
        </h3>
        <p className="text-sm text-muted-foreground">
          {isRtl ? 'لم نتمكن من العثور على أي منتجات' : "We couldn't find any products"}
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn('grid gap-3 md:gap-4', gridCols[columns])}
      role="list"
      aria-label={isRtl ? 'قائمة المنتجات' : 'Product list'}
      dir={isRtl ? 'rtl' : 'ltr'}
      data-zone="products"
    >
      {products.map((product, index) => (
        <div
          key={product.id}
          role="listitem"
          className=""
          style={{ ['--i' as string]: index } as React.CSSProperties}
        >
          <ProductCard
            product={product}
            isRtl={isRtl}
            currency={currency}
            quantityInCart={cartQuantities[product.id] ?? 0}
            onAddToCart={onAddToCart}
            onAddToWishlist={onAddToWishlist}
            urlPrefix={urlPrefix}
            isInCompare={compareIds?.has(product.id) ?? false}
            onToggleCompare={onToggleCompare}
            onRemoveFromWishlist={onRemoveFromWishlist}
            priority={index < 2}
          />
        </div>
      ))}
    </div>
  );
}
