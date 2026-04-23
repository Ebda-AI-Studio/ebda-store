'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import type { ProductCardProps } from '../types';
import { CompareButton, RemoveFromWishlistButton } from '../shared/card-actions';
import { Price, ProductBadge, ProductBadgeGroup, AddToCartButton, cn } from '@force/ui';
import { calculateDiscount } from '../shared/display-helpers';
import { PlaceholderImageIcon } from '../shared/icons';

/**
 * Bold Template - Product Card
 *
 * High-energy streetwear aesthetic: dark borders, aggressive hover,
 * bright accent colors. Uses shared components from @force/ui.
 */
export default function BoldProductCard({
  product,
  isRtl = false,
  currency = 'KWD',
  quantityInCart = 0,
  onAddToCart,
  urlPrefix = '',

  isInCompare = false,

  onToggleCompare,

  onRemoveFromWishlist,
}: ProductCardProps) {
  const [isHovered, setIsHovered] = useState(false);

  const discount = calculateDiscount(product.price, product.compareAtPrice);

  const handleAddToCart = async (productId: string) => {
    await onAddToCart?.(productId);
  };

  return (
    <Link
      href={`${urlPrefix}/products/${product.slug}`}
      className="group block relative overflow-hidden rounded-2xl bg-background border-2 border-gray-950/10 hover:border-primary hover:scale-[1.03] transition-all duration-200 cursor-pointer"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Image */}
      <div className="relative aspect-square overflow-hidden bg-muted">
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
          <Image
            src={product.images[0].url}
            alt={isRtl && product.nameAr ? product.nameAr : product.name}
            className={cn(
              'object-cover transition-transform duration-200',
              isHovered && 'scale-110'
            )}
            fill
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground/40">
            <PlaceholderImageIcon className="w-16 h-16" strokeWidth={1.5} />
          </div>
        )}

        {/* Badges */}
        <ProductBadgeGroup absolute position={isRtl ? 'top-right' : 'top-left'} isRtl={isRtl}>
          {discount > 0 && (
            <ProductBadge
              variant="sale"
              discount={discount}
              isRtl={isRtl}
              size="md"
              className="font-black px-3 py-1.5 rounded-none"
            />
          )}
          {product.isNew && (
            <ProductBadge
              variant="new"
              isRtl={isRtl}
              size="md"
              className="font-black px-3 py-1.5 rounded-none"
              label={isRtl ? 'جديد!' : 'NEW!'}
            />
          )}
        </ProductBadgeGroup>

        {/* Quick Add — slides up */}
        <div
          className={cn(
            'absolute bottom-0 inset-x-0 transition-all duration-200',
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
            className={cn(
              'w-full py-4 rounded-none font-black uppercase tracking-wider text-sm',
              'bg-gray-950 text-white hover:bg-primary hover:text-primary-foreground transition-colors duration-200'
            )}
            labels={{
              addToCart: isRtl ? 'أضف إلى السلة' : 'Add to cart',
              addedToCart: isRtl ? 'تمت الإضافة' : 'Added to cart',
              outOfStock: isRtl ? 'نفد المخزون' : 'Out of stock',
              adding: isRtl ? '...' : '...',
            }}
          />
        </div>
      </div>

      {/* Content */}
      <div className="p-4">
        <h3 className="font-black text-base uppercase tracking-tight line-clamp-1 group-hover:text-primary transition-colors duration-200">
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
