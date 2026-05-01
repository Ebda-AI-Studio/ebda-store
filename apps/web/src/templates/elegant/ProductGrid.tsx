'use client';

import type { ProductGridProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { getGridColsClass, getDisplayTitle } from '../shared';
import ProductCard from './ProductCard';

export default function ElegantProductGrid({
  products,
  isRtl: isRtlProp,
  title,
  titleAr,
  columns = 4,
  onAddToCart,
  cartQuantities = {},
  urlPrefix = '',

  compareIds,

  onToggleCompare,

  onRemoveFromWishlist,
}: ProductGridProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const displayTitle = getDisplayTitle(isRtl, title, titleAr);
  const gridCols = getGridColsClass(columns);

  return (
    <section
      className="py-12 sm:py-16 md:py-28 bg-background"
      dir={isRtl ? 'rtl' : 'ltr'}
      data-zone="products"
    >
      <div className="container mx-auto px-4">
        {/* Section header — editorial style. Eyebrow line ("Discover")
            removed; was hardcoded marketing copy. The merchant's title
            stands on its own. */}
        {displayTitle && (
          <div className="text-center mb-10 sm:mb-12 md:mb-16">
            <h2 className="text-3xl md:text-4xl font-light text-foreground tracking-wide">
              {displayTitle}
            </h2>
          </div>
        )}

        {/* Products Grid */}
        <div className={`grid ${gridCols} gap-8 md:gap-12`}>
          {products.map(product => (
            <ProductCard
              key={product.id}
              product={product}
              isRtl={isRtl}
              onAddToCart={onAddToCart}
              quantityInCart={cartQuantities[product.id]}
              urlPrefix={urlPrefix}
              isInCompare={compareIds?.has(product.id) ?? false}
              onToggleCompare={onToggleCompare}
              onRemoveFromWishlist={onRemoveFromWishlist}
            />
          ))}
        </div>

        {/* Empty State */}
        {products.length === 0 && (
          <div className="text-center py-20">
            <p className="text-sm text-muted-foreground tracking-wide">
              {isRtl ? 'لا توجد منتجات متاحة حالياً' : 'No products available at this time'}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
