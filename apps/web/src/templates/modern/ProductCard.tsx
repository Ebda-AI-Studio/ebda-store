'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { ProductCardProps } from '../types';
import {
  Price,
  ProductBadge,
  ProductBadgeGroup,
  Rating,
  AddToCartButton,
  cn,
} from '@force/ui';

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
}: ProductCardProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isWishlisted, setIsWishlisted] = useState(false);

  const discount = product.compareAtPrice
    ? Math.round(((product.compareAtPrice - product.price) / product.compareAtPrice) * 100)
    : 0;

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
      href={`/products/${product.slug}`}
      className="group relative bg-background rounded-xl overflow-hidden border border-border hover:border-primary/30 hover:shadow-xl transition-all duration-300"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Image Container */}
      <div className="relative aspect-square overflow-hidden bg-muted">
        {product.images?.[0]?.url ? (
          <>
            <img
              src={product.images[0].url}
              alt={product.images[0].alt || product.name}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
              loading="lazy"
            />
            {/* Second image on hover */}
            {product.images[1]?.url && (
              <img
                src={product.images[1].url}
                alt={product.images[1].alt || product.name}
                className={cn(
                  'absolute inset-0 w-full h-full object-cover transition-opacity duration-500',
                  isHovered ? 'opacity-100' : 'opacity-0'
                )}
                loading="lazy"
              />
            )}
          </>
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground">
            <svg className="w-16 h-16" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
        )}

        {/* Badges using shared ProductBadge component */}
        <ProductBadgeGroup
          absolute
          position={isRtl ? 'top-right' : 'top-left'}
          isRtl={isRtl}
        >
          {discount > 0 && (
            <ProductBadge
              variant="sale"
              discount={discount}
              isRtl={isRtl}
              size="sm"
            />
          )}
          {product.isNew && (
            <ProductBadge
              variant="new"
              isRtl={isRtl}
              size="sm"
            />
          )}
          {product.inStock === false && (
            <ProductBadge
              variant="soldOut"
              isRtl={isRtl}
              size="sm"
            />
          )}
        </ProductBadgeGroup>

        {/* Quick Actions */}
        <div
          className={cn(
            'absolute top-3 flex flex-col gap-2 transition-all duration-300',
            isRtl ? 'left-3' : 'right-3',
            isHovered ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-4'
          )}
        >
          <button
            onClick={handleWishlist}
            className={cn(
              'w-9 h-9 rounded-full flex items-center justify-center transition-colors',
              isWishlisted
                ? 'bg-red-500 text-white'
                : 'bg-background/90 text-foreground hover:bg-primary hover:text-primary-foreground'
            )}
            aria-label={isRtl ? 'إضافة للمفضلة' : 'Add to wishlist'}
            aria-pressed={isWishlisted}
          >
            <svg
              className="w-5 h-5"
              fill={isWishlisted ? 'currentColor' : 'none'}
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
          </button>
        </div>

        {/* Add to Cart Button Overlay */}
        <div
          className={cn(
            'absolute bottom-0 inset-x-0 p-3 bg-gradient-to-t from-black/60 to-transparent transition-all duration-300',
            isHovered ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
          )}
          onClick={(e) => e.preventDefault()}
        >
          <AddToCartButton
            productId={product.id}
            inStock={product.inStock !== false}
            quantityInCart={quantityInCart}
            isRtl={isRtl}
            onAddToCart={handleAddToCart}
            showQuantityBadge={false}
            className="w-full py-2.5 text-sm"
          />
        </div>
      </div>

      {/* Content */}
      <div className="p-4">
        {/* Rating using shared Rating component */}
        {product.rating !== undefined && (
          <Rating
            value={product.rating}
            count={product.reviewCount}
            size="sm"
            isRtl={isRtl}
            showCount
            className="mb-2"
          />
        )}

        {/* Name */}
        <h3 className="font-medium text-foreground group-hover:text-primary transition-colors line-clamp-2 mb-2">
          {isRtl && product.nameAr ? product.nameAr : product.name}
        </h3>

        {/* Price using shared Price component */}
        <Price
          price={product.price}
          compareAtPrice={product.compareAtPrice}
          currency={currency}
          isRtl={isRtl}
          size="md"
          showDiscount={false}
        />
      </div>
    </Link>
  );
}
