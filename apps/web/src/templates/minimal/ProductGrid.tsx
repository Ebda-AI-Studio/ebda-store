'use client';

import type { ProductGridProps } from '../types';
import ProductCard from './ProductCard';

export default function MinimalProductGrid({
  products,
  isRtl = false,
  title,
  titleAr,
  columns = 4,
  onAddToCart,
  cartQuantities = {},
}: ProductGridProps) {
  const displayTitle = isRtl && titleAr ? titleAr : title;

  const gridCols = {
    2: 'grid-cols-1 sm:grid-cols-2',
    3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
    4: 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4',
  }[columns] || 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4';

  return (
    <section className="py-24 md:py-32 bg-background" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="container mx-auto px-4">
        {displayTitle && (
          <h2 className="text-sm tracking-[0.2em] uppercase text-muted-foreground mb-16 text-center">
            {displayTitle}
          </h2>
        )}

        {/* Products Grid */}
        <div className={`grid ${gridCols} gap-6 md:gap-8`}>
          {products.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              isRtl={isRtl}
              onAddToCart={onAddToCart}
              quantityInCart={cartQuantities[product.id]}
            />
          ))}
        </div>

        {/* Empty State */}
        {products.length === 0 && (
          <div className="text-center py-24">
            <p className="text-sm text-muted-foreground">
              {isRtl ? 'لا توجد منتجات' : 'No products'}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
