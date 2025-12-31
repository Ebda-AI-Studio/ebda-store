'use client';

import Link from 'next/link';
import type { ProductCardProps } from '../types';
import { Price, ProductBadge, AddToCartButton, cn } from '@force/ui';

/**
 * Classic Template - Product Card
 *
 * Elegant serif-based design with minimal hover effects.
 * Uses shared components from @force/ui.
 */
export default function ClassicProductCard({
  product,
  isRtl = false,
  currency = 'KWD',
  quantityInCart = 0,
  onAddToCart,
}: ProductCardProps) {
  const handleAddToCart = async (productId: string) => {
    await onAddToCart?.(productId);
  };

  return (
    <Link href={`/products/${product.slug}`} className="group text-center">
      {/* Image */}
      <div className="relative aspect-[3/4] overflow-hidden bg-muted mb-4">
        {product.images?.[0]?.url ? (
          <img
            src={product.images[0].url}
            alt={isRtl && product.nameAr ? product.nameAr : product.name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground">
            <svg
              className="w-16 h-16"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
          </div>
        )}

        {/* Quick Add Overlay */}
        <div
          className="absolute bottom-0 inset-x-0 bg-foreground/90 py-3 translate-y-full group-hover:translate-y-0 transition-transform duration-300"
          onClick={e => e.preventDefault()}
        >
          <AddToCartButton
            productId={product.id}
            inStock={product.inStock !== false}
            quantityInCart={quantityInCart}
            isRtl={isRtl}
            onAddToCart={handleAddToCart}
            showQuantityBadge={false}
            variant="ghost"
            className={cn(
              'text-background font-serif text-sm tracking-widest uppercase',
              'hover:text-primary hover:bg-transparent transition-colors',
              'py-0 h-auto'
            )}
            labels={{
              addToCart: isRtl ? 'أضف للسلة' : 'Add to Bag',
              addedToCart: isRtl ? 'تمت الإضافة' : 'Added',
              outOfStock: isRtl ? 'نفذت الكمية' : 'Sold Out',
              adding: isRtl ? 'جاري الإضافة...' : 'Adding...',
            }}
          />
        </div>

        {/* Badges */}
        {product.isNew && (
          <ProductBadge
            variant="new"
            isRtl={isRtl}
            size="sm"
            absolute
            position={isRtl ? 'top-right' : 'top-left'}
            className="font-serif tracking-widest uppercase bg-foreground text-background rounded-none"
            label={isRtl ? 'جديد' : 'New'}
          />
        )}
        {product.inStock === false && (
          <ProductBadge
            variant="soldOut"
            isRtl={isRtl}
            size="sm"
            absolute
            position={isRtl ? 'top-right' : 'top-left'}
            className="font-serif tracking-widest uppercase rounded-none"
          />
        )}
      </div>

      {/* Content */}
      <h3 className="font-serif text-lg mb-2 group-hover:text-primary transition-colors">
        {isRtl && product.nameAr ? product.nameAr : product.name}
      </h3>

      <Price
        price={product.price}
        compareAtPrice={product.compareAtPrice}
        currency={currency}
        isRtl={isRtl}
        size="md"
        showDiscount={false}
        className="justify-center font-serif"
      />
    </Link>
  );
}
