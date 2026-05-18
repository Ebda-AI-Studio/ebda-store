'use client';

import { memo, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import type { ProductCardProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { useStore } from '../../contexts/StoreContext';
import { resolveColor } from '@force/shared';
import { CompareButton, RemoveFromWishlistButton } from '../shared/card-actions';
import { Price, ProductBadge, ProductBadgeGroup, cn } from '@force/ui';
import { calculateDiscount } from '../shared/display-helpers';
import { PlaceholderImageIcon } from '../shared/icons';
import { TaxInclusiveLabel } from '../shared/tax-inclusive-label';
import { productCardPropsEqual } from '../shared/product-card-memo';
import { ProductCardCta, OutOfStockRibbon } from '../shared/ProductCardCta';

/**
 * Bold Template - Product Card
 *
 * High-energy streetwear aesthetic: dark borders, aggressive hover,
 * bright accent colors. Uses shared components from @force/ui.
 */
function BoldProductCard({
  product,
  isRtl: isRtlProp,
  currency = 'KWD',
  quantityInCart = 0,
  onAddToCart,
  urlPrefix = '',

  isInCompare = false,

  onToggleCompare,

  onRemoveFromWishlist,
  showCardFrame,
  cardFrameStyle: _cardFrameStyle,
  cardFrameColor,
}: ProductCardProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const { store } = useStore();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const [isHovered, setIsHovered] = useState(false);

  const discount = calculateDiscount(product.price, product.compareAtPrice);

  const handleAddToCart = async (productId: string) => {
    await onAddToCart?.(productId);
  };

  return (
    <article
      itemScope
      itemType="https://schema.org/Product"
      aria-labelledby={`prod-${product.id}-name`}
      className="w-full md:max-w-[200px] mx-auto"
      style={
        showCardFrame && cardFrameColor && store.theme
          ? { borderColor: resolveColor(cardFrameColor, store.theme) }
          : undefined
      }
    >
      <Link
        href={`${urlPrefix}/products/${product.slug}`}
        prefetch={false}
        className="group block relative overflow-hidden rounded-2xl bg-background border-2 border-foreground/15 hover:border-foreground hover:translate-x-1 hover:-translate-y-1 hover:shadow-[6px_6px_0_0_hsl(var(--foreground)/0.92)] transition-all duration-200 ease-out cursor-pointer"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Image */}
        <div className="relative aspect-square overflow-hidden bg-muted">
          {/* Platform-level OOS ribbon (red, prominent) — same visual
              across every theme (2026-05-16). */}
          <OutOfStockRibbon inStock={product.inStock !== false} isRtl={isRtl} />
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
                'object-cover transition-transform duration-300 ease-out',
                isHovered && 'scale-[1.05]'
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

          {/* Quick Add — always visible on touch (mobile/tablet); slides up on hover for pointer devices.
            Touch devices can't trigger :hover, so the button stayed unreachable on phones. */}
          <div
            className={cn(
              'absolute bottom-0 inset-x-0 transition-all duration-200',
              'opacity-100 translate-y-0',
              'lg:opacity-0 lg:translate-y-full',
              isHovered && 'lg:opacity-100 lg:translate-y-0'
            )}
            onClick={e => e.preventDefault()}
          >
            <ProductCardCta
              productId={product.id}
              inStock={product.inStock !== false}
              hasVariants={!!product.variants && product.variants.length > 0}
              viewHref={`${urlPrefix}/products/${product.slug}`}
              quantityInCart={quantityInCart}
              isRtl={isRtl}
              onAddToCart={handleAddToCart}
              className={cn(
                'w-full py-4 rounded-none font-black uppercase tracking-wider text-sm cursor-pointer inline-flex items-center justify-center',
                'bg-gray-950 text-white hover:bg-primary hover:text-primary-foreground transition-colors duration-200'
              )}
              labels={{
                addToCart: isRtl ? 'أضف إلى السلة' : 'Add to cart',
                addedToCart: isRtl ? 'تمت الإضافة' : 'Added to cart',
                outOfStock: isRtl ? 'نفد المخزون' : 'Out of stock',
                adding: isRtl ? '...' : '...',
                view: isRtl ? 'عرض' : 'View',
              }}
            />
          </div>
        </div>

        {/* Content — tightened p-5 → p-3 sm:p-4 (2026-05-16 size reduction). */}
        <div className="flex flex-col gap-2 p-3 sm:p-4">
          <h3
            id={`prod-${product.id}-name`}
            data-zone="productName"
            className="font-black text-base uppercase tracking-tight line-clamp-1 group-hover:text-primary transition-colors duration-200"
            itemProp="name"
          >
            {isRtl && product.nameAr ? product.nameAr : product.name}
          </h3>
          <span itemProp="offers" itemScope itemType="https://schema.org/Offer">
            <meta itemProp="priceCurrency" content={currency} />
            <meta itemProp="price" content={String(product.price / 1000)} />
          </span>
          <Price
            price={product.price}
            compareAtPrice={product.compareAtPrice}
            currency={currency}
            isRtl={isRtl}
            size="lg"
            showDiscount={false}
            className="font-black"
          />
          <TaxInclusiveLabel className="block text-xs uppercase tracking-wide text-muted-foreground" />
        </div>
      </Link>
    </article>
  );
}

export default memo(BoldProductCard, productCardPropsEqual);
