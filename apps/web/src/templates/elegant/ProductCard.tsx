'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { ProductCardProps } from '../types';
import { Price, ProductBadge, ProductBadgeGroup, AddToCartButton, cn } from '@force/ui';

/**
 * Elegant Template - Product Card
 *
 * Fashion-forward design with refined transitions.
 * Uses shared components from @force/ui.
 */
export default function ElegantProductCard({
  product,
  isRtl = false,
  currency = 'KWD',
  quantityInCart = 0,
  onAddToCart,
  onAddToWishlist,
}: ProductCardProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isWishlisted, setIsWishlisted] = useState(false);

  const handleAddToCart = async (productId: string) => {
    await onAddToCart?.(productId);
  };

  const handleWishlist = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsWishlisted(!isWishlisted);
    onAddToWishlist?.(product.id);
  };

  const hasSale = product.compareAtPrice && product.compareAtPrice > product.price;

  return (
    <Link
      href={`/products/${product.slug}`}
      className="group block"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Image */}
      <div className="relative aspect-[3/4] overflow-hidden bg-muted/20 mb-4">
        {product.images?.[0]?.url ? (
          <>
            <img
              src={product.images[0].url}
              alt={isRtl && product.nameAr ? product.nameAr : product.name}
              className="w-full h-full object-cover transition-opacity duration-700"
              style={{ opacity: isHovered && product.images[1]?.url ? 0 : 1 }}
              loading="lazy"
            />
            {product.images[1]?.url && (
              <img
                src={product.images[1].url}
                alt={isRtl && product.nameAr ? product.nameAr : product.name}
                className="absolute inset-0 w-full h-full object-cover transition-opacity duration-700"
                style={{ opacity: isHovered ? 1 : 0 }}
                loading="lazy"
              />
            )}
          </>
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground/20">
            <svg className="w-16 h-16" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={0.5} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
        )}

        {/* Wishlist */}
        <button
          onClick={handleWishlist}
          className={cn(
            'absolute top-4 p-2 transition-all duration-300',
            isRtl ? 'left-4' : 'right-4',
            isHovered || isWishlisted ? 'opacity-100' : 'opacity-0'
          )}
          aria-label={isRtl ? 'إضافة للمفضلة' : 'Add to wishlist'}
          aria-pressed={isWishlisted}
        >
          <svg
            className={cn(
              'w-5 h-5 transition-colors',
              isWishlisted ? 'text-primary fill-primary' : 'text-foreground'
            )}
            fill={isWishlisted ? 'currentColor' : 'none'}
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={1}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
          </svg>
        </button>

        {/* Badges */}
        <ProductBadgeGroup
          absolute
          position={isRtl ? 'top-right' : 'top-left'}
          isRtl={isRtl}
        >
          {product.isNew && (
            <ProductBadge
              variant="new"
              isRtl={isRtl}
              size="sm"
              className="text-[10px] tracking-[0.2em] uppercase rounded-none bg-foreground text-background"
              label={isRtl ? 'جديد' : 'New'}
            />
          )}
          {hasSale && (
            <ProductBadge
              variant="sale"
              isRtl={isRtl}
              size="sm"
              className="text-[10px] tracking-[0.2em] uppercase rounded-none"
              label={isRtl ? 'تخفيض' : 'Sale'}
            />
          )}
        </ProductBadgeGroup>

        {/* Quick Add */}
        <div
          className={cn(
            'absolute bottom-0 inset-x-0 bg-background/95 backdrop-blur-sm transition-all duration-300',
            isHovered ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-full'
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
            variant="ghost"
            className={cn(
              'w-full py-4 text-xs tracking-[0.2em] uppercase',
              'hover:bg-primary hover:text-primary-foreground rounded-none'
            )}
            labels={{
              addToCart: isRtl ? 'أضف للسلة' : 'Add to Bag',
              addedToCart: isRtl ? 'تمت الإضافة' : 'Added',
              outOfStock: isRtl ? 'نفذت الكمية' : 'Sold Out',
              adding: isRtl ? 'جاري...' : 'Adding...',
            }}
          />
        </div>
      </div>

      {/* Content */}
      <div className="text-center space-y-2">
        <h3 className="text-sm tracking-wide group-hover:text-primary transition-colors">
          {isRtl && product.nameAr ? product.nameAr : product.name}
        </h3>
        <Price
          price={product.price}
          compareAtPrice={product.compareAtPrice}
          currency={currency}
          isRtl={isRtl}
          size="sm"
          showDiscount={false}
          className="justify-center"
        />
      </div>
    </Link>
  );
}
