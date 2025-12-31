'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { ProductCardProps } from '../types';
import { Price, ProductBadge, ProductBadgeGroup, AddToCartButton, cn } from '@force/ui';

/**
 * Bold Template - Product Card
 *
 * Vibrant, energetic design with playful animations.
 * Uses shared components from @force/ui.
 */
export default function BoldProductCard({
  product,
  isRtl = false,
  currency = 'KWD',
  quantityInCart = 0,
  onAddToCart,
}: ProductCardProps) {
  const [isHovered, setIsHovered] = useState(false);

  const discount = product.compareAtPrice
    ? Math.round(((product.compareAtPrice - product.price) / product.compareAtPrice) * 100)
    : 0;

  const handleAddToCart = async (productId: string) => {
    await onAddToCart?.(productId);
  };

  return (
    <Link
      href={`/products/${product.slug}`}
      className="group block relative overflow-hidden rounded-3xl bg-background border-4 border-border hover:border-primary transition-colors"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Image */}
      <div className="relative aspect-square overflow-hidden bg-muted">
        {product.images?.[0]?.url ? (
          <img
            src={product.images[0].url}
            alt={isRtl && product.nameAr ? product.nameAr : product.name}
            className={cn(
              'w-full h-full object-cover transition-transform duration-500',
              isHovered && 'scale-110 rotate-2'
            )}
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
                strokeWidth={2}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
          </div>
        )}

        {/* Badges - playful rotations */}
        <ProductBadgeGroup absolute position={isRtl ? 'top-right' : 'top-left'} isRtl={isRtl}>
          {discount > 0 && (
            <ProductBadge
              variant="sale"
              discount={discount}
              isRtl={isRtl}
              size="md"
              className="font-black px-4 py-2 transform -rotate-3"
            />
          )}
          {product.isNew && (
            <ProductBadge
              variant="new"
              isRtl={isRtl}
              size="md"
              className="font-black px-4 py-2 transform rotate-3"
              label={isRtl ? 'جديد!' : 'NEW!'}
            />
          )}
        </ProductBadgeGroup>

        {/* Quick Add */}
        <div
          className={cn(
            'absolute bottom-4 inset-x-4 transition-all duration-300',
            isHovered ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
          )}
          onClick={e => e.preventDefault()}
        >
          <AddToCartButton
            productId={product.id}
            inStock={product.inStock !== false}
            quantityInCart={quantityInCart}
            isRtl={isRtl}
            onAddToCart={handleAddToCart}
            showQuantityBadge={false}
            className={cn(
              'w-full py-4 rounded-2xl font-black uppercase tracking-wider text-sm',
              'bg-foreground text-background hover:bg-primary hover:text-primary-foreground'
            )}
            labels={{
              addToCart: isRtl ? 'أضف للسلة' : 'Add to Cart',
              addedToCart: isRtl ? 'تمت!' : 'Added!',
              outOfStock: isRtl ? 'نفذ!' : 'Sold Out!',
              adding: isRtl ? '...' : '...',
            }}
          />
        </div>
      </div>

      {/* Content */}
      <div className="p-4">
        <h3 className="font-black text-lg uppercase tracking-tight line-clamp-1 group-hover:text-primary transition-colors">
          {isRtl && product.nameAr ? product.nameAr : product.name}
        </h3>
        <Price
          price={product.price}
          compareAtPrice={product.compareAtPrice}
          currency={currency}
          isRtl={isRtl}
          size="lg"
          showDiscount={false}
          className="mt-2 font-black"
        />
      </div>
    </Link>
  );
}
