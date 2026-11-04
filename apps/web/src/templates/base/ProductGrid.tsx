'use client';

import type { ProductGridProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { getGridColsClass, getDisplayTitle, fitDesktopColumns } from '../shared';
import ProductCard from './ProductCard';

export default function MinimalProductGrid({
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
  const gridCols = getGridColsClass(fitDesktopColumns(products.length, columns) as 2 | 3 | 4 | 5);

  return (
    <section
      className="py-12 sm:py-20 md:py-32 bg-background"
      dir={isRtl ? 'rtl' : 'ltr'}
      data-zone="products"
    >
      <div className="container mx-auto px-4">
        {displayTitle && (
          <h2 className="text-sm tracking-[0.2em] uppercase text-muted-foreground mb-10 sm:mb-12 md:mb-16 text-center">
            {displayTitle}
          </h2>
        )}

        {/* Products Grid */}
        <div data-part="product-grid" className={`grid ${gridCols} gap-3 md:gap-4`}>
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
          <div className="text-center py-24">
            <p className="text-sm text-muted-foreground">{isRtl ? 'مفيش منتجات' : 'No products'}</p>
          </div>
        )}
      </div>
    </section>
  );
}
