'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import type { ProductCardProps } from '../types';
import { CompareButton, RemoveFromWishlistButton } from '../shared/card-actions';
import { Price, ProductBadge, ProductBadgeGroup, AddToCartButton, cn } from '@force/ui';
import { PlaceholderImageIcon } from '../shared/icons';

/**
 * Elegant Template - Product Card
 *
 * Luxury fashion aesthetic: no borders, portrait aspect ratio, ultra-subtle
 * hover states. Uses shared components from @force/ui.
 */
export default function ElegantProductCard({
  product,
  isRtl = false,
  currency = 'KWD',
  quantityInCart = 0,
  onAddToCart,
  onAddToWishlist,
  urlPrefix = '',

  isInCompare = false,

  onToggleCompare,

  onRemoveFromWishlist,
}: ProductCardProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isWishlisted, setIsWishlisted] = useState(false);

  const handleAddToCart = async (productId: string) => {
    await onAddToCart?.(productId);
  };

  const handleWishlist = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsWishlisted(prev => !prev);
    onAddToWishlist?.(product.id);
  };

  const hasSale = product.compareAtPrice && product.compareAtPrice > product.price;

  return (
    <Link
      href={`${urlPrefix}/products/${product.slug}`}
      className="group block cursor-pointer"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Image — fashion portrait ratio */}
      <div className="relative aspect-[3/4] overflow-hidden bg-gray-50 mb-4">
        {onToggleCompare && (
          <CompareButton
            productId={product.id}
            isInCompare={isInCompare}
            onToggle={onToggleCompare}
            isRtl={isRtl}
          />
        )}
        {onRemoveFromWishlist && (
          <RemoveFromWishlistButton
            productId={product.id}
            onRemove={onRemoveFromWishlist}
            isRtl={isRtl}
          />
        )}
        {product.images?.[0]?.url ? (
          <>
            <Image
              src={product.images[0].url}
              alt={isRtl && product.nameAr ? product.nameAr : product.name}
              className={cn(
                'object-cover transition-all duration-500',
                isHovered ? 'brightness-95 scale-[1.02]' : 'brightness-100 scale-100'
              )}
              style={{
                opacity: isHovered && product.images[1]?.url ? 0 : 1,
                transition: 'opacity 500ms, filter 500ms, transform 500ms',
              }}
              fill
              sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
              loading="lazy"
            />
            {product.images[1]?.url && (
              <Image
                src={product.images[1].url}
                alt={isRtl && product.nameAr ? product.nameAr : product.name}
                className="object-cover transition-opacity duration-500"
                style={{ opacity: isHovered ? 1 : 0 }}
                fill
                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                loading="lazy"
              />
            )}
          </>
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground/20">
            <PlaceholderImageIcon className="w-16 h-16" strokeWidth={0.5} />
          </div>
        )}

        {/* Wishlist */}
        <button
          onClick={handleWishlist}
          className={cn(
            'absolute top-4 p-2 transition-all duration-300 cursor-pointer',
            isRtl ? 'left-4' : 'right-4',
            isHovered || isWishlisted ? 'opacity-100' : 'opacity-0'
          )}
          aria-label={isRtl ? 'إضافة للمفضلة' : 'Add to wishlist'}
          aria-pressed={isWishlisted}
        >
          <svg
            className={cn(
              'w-5 h-5 transition-colors duration-300',
              isWishlisted ? 'text-foreground fill-foreground' : 'text-foreground'
            )}
            fill={isWishlisted ? 'currentColor' : 'none'}
            stroke="currentColor"
            viewBox="0 0 24 24"
            strokeWidth={1}
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
            />
          </svg>
        </button>

        {/* Badges */}
        <ProductBadgeGroup absolute position={isRtl ? 'top-right' : 'top-left'} isRtl={isRtl}>
          {product.isNew && (
            <ProductBadge
              variant="new"
              isRtl={isRtl}
              size="sm"
              className="text-[9px] tracking-[0.2em] uppercase rounded-none bg-foreground text-background font-normal"
              label={isRtl ? 'جديد' : 'New'}
            />
          )}
          {hasSale && (
            <ProductBadge
              variant="sale"
              isRtl={isRtl}
              size="sm"
              className="text-[9px] tracking-[0.2em] uppercase rounded-none font-normal"
              label={isRtl ? 'تخفيض' : 'Sale'}
            />
          )}
        </ProductBadgeGroup>

        {/* Quick Add — slides up from bottom */}
        <div
          className={cn(
            'absolute bottom-0 inset-x-0 bg-background/95 backdrop-blur-sm transition-all duration-300',
            isHovered ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-full'
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
            variant="ghost"
            className={cn(
              'w-full py-4 text-[10px] tracking-[0.25em] uppercase font-normal rounded-none',
              'hover:bg-foreground hover:text-background transition-colors duration-300'
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

      {/* Content — refined, centered */}
      <div className="text-center space-y-1.5">
        <h3 className="text-xs tracking-[0.15em] uppercase text-foreground/80 group-hover:text-foreground transition-colors duration-300 line-clamp-1">
          {isRtl && product.nameAr ? product.nameAr : product.name}
        </h3>
        <Price
          price={product.price}
          compareAtPrice={product.compareAtPrice}
          currency={currency}
          isRtl={isRtl}
          size="sm"
          showDiscount={false}
          className="justify-center text-muted-foreground font-light"
        />
      </div>
    </Link>
  );
}
