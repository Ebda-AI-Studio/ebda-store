'use client';

import type { ProductGridProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { getGridColsClass, getDisplayTitle } from '../shared';
import ProductCard from './ProductCard';
import { NoProductsIcon } from '../shared/icons';

export default function ClassicProductGrid({
  products,
  isRtl: isRtlProp,
  title,
  titleAr,
  showFilters: _showFilters = false,
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
      className="py-10 sm:py-14 md:py-24 bg-background"
      dir={isRtl ? 'rtl' : 'ltr'}
      data-zone="products"
    >
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
        <div className={`grid ${gridCols} gap-3 md:gap-4`}>
          {products.map((product, i) => (
            // Item 3 (2026-07-12): first-render stagger fade, 40ms step,
            // motion-safe only — no layout shift (opacity/transform only).
            <div
              key={product.id}
              className=""
              style={{ ['--i' as string]: i } as React.CSSProperties}
            >
              <ProductCard
                product={product}
                isRtl={isRtl}
                onAddToCart={onAddToCart}
                quantityInCart={cartQuantities[product.id]}
                urlPrefix={urlPrefix}
                isInCompare={compareIds?.has(product.id) ?? false}
                onToggleCompare={onToggleCompare}
                onRemoveFromWishlist={onRemoveFromWishlist}
                priority={i < 6}
              />
            </div>
          ))}
        </div>

        {/* Empty State */}
        {products.length === 0 && (
          <div className="text-center py-16">
            <div className="w-16 h-16 mx-auto mb-6 border border-border/50 flex items-center justify-center">
              <NoProductsIcon className="w-8 h-8 text-muted-foreground" />
            </div>
            <p className="text-muted-foreground">
              {isRtl ? 'مفيش منتجات متاحة' : 'No products available'}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
