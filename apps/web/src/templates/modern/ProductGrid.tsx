'use client';

import ProductCard from './ProductCard';
import type { ProductGridProps } from '../types';
import { cn } from '@force/ui';
import { NoProductsIcon } from '../shared/icons';

/**
 * Modern Template - Product Grid
 *
 * Renders a responsive grid of ProductCards with:
 * - Responsive column layout
 * - Empty state handling
 * - Cart quantity tracking per product
 */
export default function ModernProductGrid({
  products,
  isRtl = false,
  currency = 'KWD',
  columns = 4,
  cartQuantities = {},
  onAddToCart,
  onAddToWishlist,
  urlPrefix = '',
}: ProductGridProps) {
  const gridCols = {
    2: 'grid-cols-2',
    3: 'grid-cols-2 md:grid-cols-3',
    4: 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4',
  };

  if (products.length === 0) {
    return (
      <div
        className="py-16 text-center"
        role="status"
        aria-label={isRtl ? 'لا توجد منتجات' : 'No products found'}
      >
        <div className="w-24 h-24 mx-auto mb-6 rounded-full bg-muted flex items-center justify-center">
          <NoProductsIcon />
        </div>
        <h3 className="text-lg font-semibold text-foreground mb-2">
          {isRtl ? 'لا توجد منتجات' : 'No products found'}
        </h3>
        <p className="text-muted-foreground">
          {isRtl ? 'لم نتمكن من العثور على أي منتجات' : "We couldn't find any products"}
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn('grid gap-4 md:gap-6', gridCols[columns])}
      role="list"
      aria-label={isRtl ? 'قائمة المنتجات' : 'Product list'}
    >
      {products.map(product => (
        <div key={product.id} role="listitem">
          <ProductCard
            product={product}
            isRtl={isRtl}
            currency={currency}
            quantityInCart={cartQuantities[product.id] ?? 0}
            onAddToCart={onAddToCart}
            onAddToWishlist={onAddToWishlist}
            urlPrefix={urlPrefix}
          />
        </div>
      ))}
    </div>
  );
}
