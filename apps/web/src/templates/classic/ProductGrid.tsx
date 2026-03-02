'use client';

import type { ProductGridProps } from '../types';
import ProductCard from './ProductCard';

export default function ClassicProductGrid({
  products,
  isRtl = false,
  title,
  titleAr,
  showFilters: _showFilters = false,
  columns = 4,
  onAddToCart,
  cartQuantities = {},
  urlPrefix = '',
}: ProductGridProps) {
  const displayTitle = isRtl && titleAr ? titleAr : title;

  const gridCols =
    {
      2: 'grid-cols-1 sm:grid-cols-2',
      3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
      4: 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4',
    }[columns] || 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4';

  return (
    <section className="py-16 md:py-24 bg-background" dir={isRtl ? 'rtl' : 'ltr'}>
      <div className="container mx-auto px-4">
        {/* Section Header - Elegant centered */}
        {displayTitle && (
          <div className="text-center mb-12 md:mb-16">
            <div className="w-12 h-px bg-border mx-auto mb-6" />
            <h2 className="text-2xl md:text-3xl lg:text-4xl font-serif font-normal text-foreground">
              {displayTitle}
            </h2>
            <div className="w-12 h-px bg-border mx-auto mt-6" />
          </div>
        )}

        {/* Products Grid */}
        <div className={`grid ${gridCols} gap-8 md:gap-10`}>
          {products.map(product => (
            <ProductCard
              key={product.id}
              product={product}
              isRtl={isRtl}
              onAddToCart={onAddToCart}
              quantityInCart={cartQuantities[product.id]}
              urlPrefix={urlPrefix}
            />
          ))}
        </div>

        {/* Empty State */}
        {products.length === 0 && (
          <div className="text-center py-16">
            <div className="w-16 h-16 mx-auto mb-6 border border-border/50 flex items-center justify-center">
              <svg
                className="w-8 h-8 text-muted-foreground/50"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1}
                  d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                />
              </svg>
            </div>
            <p className="text-muted-foreground">
              {isRtl ? 'لا توجد منتجات متاحة' : 'No products available'}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
