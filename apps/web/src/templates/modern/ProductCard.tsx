'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import type { ProductCardProps } from '../types';
import { Price, ProductBadge, ProductBadgeGroup, Rating, AddToCartButton, cn } from '@force/ui';
import { calculateDiscount } from '../shared/display-helpers';
import { PlaceholderImageIcon } from '../shared/icons';

/**
 * Modern Template - Product Card
 *
 * Uses shared components from @force/ui:
 * - Price: Currency formatting with discount display
 * - ProductBadge: Sale, new, sold out badges
 * - Rating: Star rating display
 * - AddToCartButton: Add to cart with states
 */
export default function ModernProductCard({
  product,
  isRtl = false,
  currency = 'KWD',
  onAddToCart,
  onAddToWishlist,
  quantityInCart = 0,
  urlPrefix = '',
}: ProductCardProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isWishlisted, setIsWishlisted] = useState(false);

  const discount = calculateDiscount(product.price, product.compareAtPrice);

  const handleWishlist = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsWishlisted(!isWishlisted);
    onAddToWishlist?.(product.id);
  };

  const handleAddToCart = async (productId: string) => {
    await onAddToCart?.(productId);
  };

  return (
    <Link
      href={`${urlPrefix}/products/${product.slug}`}
      className="group relative bg-background rounded-xl overflow-hidden border border-border/60 hover:border-primary/20 hover:shadow-xl hover:shadow-black/5 hover:-translate-y-0.5 transition-all duration-300 flex flex-col cursor-pointer"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Image Container */}
      <div className="relative aspect-[3/4] overflow-hidden bg-muted">
        {product.images?.[0]?.url ? (
          <>
            <Image
              src={product.images[0].url}
              alt={product.images[0].alt || product.name}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500 ease-out"
              fill
              sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
              loading="lazy"
            />
            {/* Second image on hover */}
            {product.images[1]?.url && (
              <Image
                src={product.images[1].url}
                alt={product.images[1].alt || product.name}
                className={cn(
                  'object-cover transition-opacity duration-500',
                  isHovered ? 'opacity-100' : 'opacity-0'
                )}
                fill
                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                loading="lazy"
              />
            )}
          </>
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground/40">
            <PlaceholderImageIcon className="w-20 h-20" />
          </div>
        )}

        {/* Badges */}
        <ProductBadgeGroup absolute position={isRtl ? 'top-right' : 'top-left'} isRtl={isRtl}>
          {discount > 0 && (
            <ProductBadge variant="sale" discount={discount} isRtl={isRtl} size="sm" />
          )}
          {product.isNew && <ProductBadge variant="new" isRtl={isRtl} size="sm" />}
          {product.inStock === false && <ProductBadge variant="soldOut" isRtl={isRtl} size="sm" />}
        </ProductBadgeGroup>

        {/* Wishlist Button */}
        <div
          className={cn(
            'absolute top-3 flex flex-col gap-2 transition-all duration-300',
            isRtl ? 'left-3' : 'right-3',
            isHovered ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-3'
          )}
        >
          <button
            onClick={handleWishlist}
            className={cn(
              'w-9 h-9 rounded-full flex items-center justify-center shadow-md transition-all duration-200 cursor-pointer',
              isWishlisted
                ? 'bg-red-500 text-white scale-110'
                : 'bg-white/95 text-foreground hover:bg-white hover:scale-110'
            )}
            aria-label={isRtl ? 'إضافة للمفضلة' : 'Add to wishlist'}
            aria-pressed={isWishlisted}
          >
            <svg
              className="w-4 h-4"
              fill={isWishlisted ? 'currentColor' : 'none'}
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
              />
            </svg>
          </button>
        </div>

        {/* Quick Add Button — slides up from bottom */}
        <div
          className={cn(
            'absolute bottom-0 inset-x-0 transition-all duration-300 ease-out',
            isHovered ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-full'
          )}
          onClick={e => e.preventDefault()}
        >
          <div className="bg-gradient-to-t from-black/50 via-black/20 to-transparent pt-8 px-3 pb-3">
            <AddToCartButton
              productId={product.id}
              inStock={product.inStock !== false}
              quantityInCart={quantityInCart}
              isRtl={isRtl}
              onAddToCart={handleAddToCart}
              showQuantityBadge={false}
              className="w-full py-2.5 text-sm font-semibold rounded-lg"
            />
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="p-4 flex flex-col gap-2 flex-1">
        {product.rating !== undefined && (
          <Rating
            value={product.rating}
            count={product.reviewCount}
            size="sm"
            isRtl={isRtl}
            showCount
          />
        )}

        <h3
          className={`font-semibold text-sm text-foreground group-hover:text-primary transition-colors duration-200 line-clamp-2 leading-snug ${isRtl ? 'text-right' : ''}`}
        >
          {isRtl && product.nameAr ? product.nameAr : product.name}
        </h3>

        <div className="mt-auto pt-1">
          <Price
            price={product.price}
            compareAtPrice={product.compareAtPrice}
            currency={currency}
            isRtl={isRtl}
            size="md"
            showDiscount={false}
          />
        </div>
      </div>
    </Link>
  );
}
