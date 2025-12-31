'use client';

import type { ProductGridProps } from '../types';
import ProductCard from './ProductCard';

export default function BoldProductGrid({
  products,
  isRtl = false,
  title,
  titleAr,
  columns = 4,
  onAddToCart,
  cartQuantities = {},
}: ProductGridProps) {
  const displayTitle = isRtl && titleAr ? titleAr : title;

  const gridCols =
    {
      2: 'grid-cols-1 sm:grid-cols-2',
      3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
      4: 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4',
    }[columns] || 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4';

  return (
    <section
      className="py-20 md:py-28 bg-background relative overflow-hidden"
      dir={isRtl ? 'rtl' : 'ltr'}
    >
      {/* Background accents */}
      <div className="absolute bottom-0 right-0 w-1/2 h-1/2 bg-primary/5 rounded-full blur-3xl translate-x-1/2 translate-y-1/2" />

      <div className="container mx-auto px-4 relative z-10">
        {/* Section Header */}
        {displayTitle && (
          <div className="text-center mb-16">
            <h2 className="text-4xl md:text-5xl lg:text-6xl font-black text-foreground tracking-tight">
              {displayTitle}
            </h2>
            <div className="mt-4 w-24 h-2 bg-primary mx-auto rounded-full" />
          </div>
        )}

        {/* Products Grid */}
        <div className={`grid ${gridCols} gap-6 md:gap-8`}>
          {products.map(product => (
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
          <div className="text-center py-20">
            <div className="w-24 h-24 mx-auto mb-6 bg-muted rounded-3xl flex items-center justify-center">
              <span className="text-4xl">📦</span>
            </div>
            <p className="text-xl font-bold text-muted-foreground">
              {isRtl ? 'لا توجد منتجات بعد' : 'No products yet'}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
