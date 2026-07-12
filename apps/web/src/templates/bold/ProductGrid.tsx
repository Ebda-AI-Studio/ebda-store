'use client';

import type { ProductGridProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { getGridColsClass, getDisplayTitle } from '../shared';
import ProductCard from './ProductCard';

export default function BoldProductGrid({
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
      className="py-12 sm:py-16 md:py-28 bg-background relative overflow-hidden"
      dir={isRtl ? 'rtl' : 'ltr'}
      data-zone="products"
    >
      {/* Background accents */}
      <div className="absolute bottom-0 right-0 w-1/2 h-1/2 bg-primary/5 rounded-full blur-3xl translate-x-1/2 translate-y-1/2" />

      <div className="container mx-auto px-4 relative z-10">
        {/* Section Header */}
        {displayTitle && (
          <div className="text-center mb-10 sm:mb-12 md:mb-16">
            <h2 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-black text-foreground tracking-tight">
              {displayTitle}
            </h2>
            <div className="mt-4 w-24 h-2 bg-primary mx-auto rounded-full" />
          </div>
        )}

        {/* Products Grid */}
        <div className={`grid ${gridCols} gap-3 md:gap-4`}>
          {products.map((product, i) => (
            // Item 3 (2026-07-12): first-render stagger fade, 40ms step,
            // motion-safe only — no layout shift (opacity/transform only).
            <div
              key={product.id}
              className="motion-safe:[animation:fadeUp_0.5s_ease-out_calc(var(--i)*40ms)_both] motion-reduce:opacity-100"
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
