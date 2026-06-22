'use client';

import { memo, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import type { ProductCardProps } from '../types';
import {
  productSizeClass,
  cardFrameClass,
  cardFrameWidthClass,
  cardFrameSizeClass,
  cardAspectClass,
  cardShapeClasses,
  cardImageAspectClass,
  cardImageRadiusClass,
} from '../shared/card-size';
import { useLanguage } from '../../contexts/LanguageContext';
import { useStore } from '../../contexts/StoreContext';
import { resolveColor, getProductCardTextSizes } from '@force/shared';
import { Price, ProductBadge, ProductBadgeGroup, Rating, cn } from '@force/ui';
import { calculateDiscount } from '../shared/display-helpers';
import { PlaceholderImageIcon } from '../shared/icons';
import { CompareButton, RemoveFromWishlistButton } from '../shared/card-actions';
import { TaxInclusiveLabel } from '../shared/tax-inclusive-label';
import { productCardPropsEqual } from '../shared/product-card-memo';
import { ProductCardCta, OutOfStockRibbon } from '../shared/ProductCardCta';

/**
 * Modern Template - Product Card
 *
 * Uses shared components from @force/ui:
 * - Price: Currency formatting with discount display
 * - ProductBadge: Sale, new, sold out badges
 * - Rating: Star rating display
 * - AddToCartButton: Add to cart with states
 */
function ModernProductCard({
  product,
  isRtl: isRtlProp,
  currency = 'KWD',
  onAddToCart,
  onAddToWishlist,
  quantityInCart = 0,
  isInCompare = false,
  onToggleCompare,
  onRemoveFromWishlist,
  urlPrefix = '',
  showCardFrame,
  cardSize,
  cardAspect,
  cardShape,
  showLabel,
  showHover,
  cardFrameStyle,
  cardFrameWidth,
  cardFrameSize,
  cardFrameColor,
  priority = false,
  // Items 8/9
  cardImageAspect,
  cardImageRadius,
  showCardName,
  showCardPrice,
}: ProductCardProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const { store } = useStore();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const [isHovered, setIsHovered] = useState(false);
  const [isWishlisted, setIsWishlisted] = useState(false);

  // PC-1/PC-2: derive name/price sizes and body padding from the canonical
  // helper so a single cardSize drives the whole card (2026-06-05).
  const textSizes = getProductCardTextSizes(cardSize);

  // PC-3: aspect override — cardShape named preset wins, then cardAspect enum,
  // then theme default (mobile square / desktop portrait).
  const shape = cardShapeClasses(cardShape);
  const aspectOverride = shape.aspect || cardAspectClass(cardAspect);

  // Item 8 — per-card image aspect + radius overrides.
  const imgAspectCls = cardImageAspectClass(cardImageAspect);
  const imgRadiusCls = cardImageRadiusClass(cardImageRadius);

  // Items 6 / 9 — price + name visibility.
  const showPriceOnCards = store.theme?.showPriceOnCards !== false;
  const priceVisible = showPriceOnCards && showCardPrice !== false;
  const nameVisible = showCardName !== false;
  // Item 10 — image normalization.
  const normalizeImages = store.theme?.normalizeProductImages === true;

  const discount = calculateDiscount(product.price, product.compareAtPrice);
  // Localized name for alt text + display. Falls through to English when
  // the merchant hasn't supplied an Arabic translation.
  const displayName = isRtl && product.nameAr ? product.nameAr : product.name;

  if (process.env.NODE_ENV !== 'production' && !product.images?.[0]?.url) {
    console.warn(`[ProductCard] Missing image for product "${product.name}" (id: ${product.id})`);
  }

  const handleWishlist = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsWishlisted(!isWishlisted);
    onAddToWishlist?.(product.id);
  };

  const handleAddToCart = async (productId: string) => {
    await onAddToCart?.(productId);
  };

  const frameCls =
    `${cardFrameClass(showCardFrame, cardFrameStyle)} ${showCardFrame ? cardFrameWidthClass(cardFrameWidth) : ''} ${showCardFrame ? cardFrameSizeClass(cardFrameSize) : ''}`.trim();

  return (
    <article
      itemScope
      itemType="https://schema.org/Product"
      aria-labelledby={`prod-${product.id}-name`}
      // max-w cap matches PecannbeeProductCard so theme grids (PDP related
      // products, category pages) render at the same size as the main
      // listings. Ahmad 2026-05-16 design.md baseline.
      className={`w-full mx-auto ${productSizeClass(cardSize)} ${frameCls}`.trim()}
      style={
        showCardFrame && cardFrameColor && store.theme
          ? { borderColor: resolveColor(cardFrameColor, store.theme) }
          : undefined
      }
    >
      <Link
        href={`${urlPrefix}/products/${product.slug}`}
        prefetch={false}
        className="group relative bg-background rounded-xl overflow-hidden border border-border/60 hover:border-foreground/15 hover:shadow-[0_24px_48px_-20px_hsl(var(--foreground)/0.12)] hover:-translate-y-0.5 transition-all duration-500 ease-out flex flex-col cursor-pointer"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Image Container — item 8: aspect+radius from admin overrides. */}
        <div
          className={`relative overflow-hidden bg-muted ${imgRadiusCls} ${imgAspectCls || aspectOverride || 'aspect-square sm:aspect-[3/4]'}`}
        >
          {product.images?.[0]?.url ? (
            <>
              <Image
                src={product.images[0].url}
                alt={product.images[0].alt || displayName}
                className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-700 ease-out"
                fill
                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                priority={priority}
                style={normalizeImages ? { objectFit: 'cover' } : undefined}
              />
              {/* Second image on hover */}
              {showHover !== false && product.images[1]?.url && (
                <Image
                  src={product.images[1].url}
                  alt={product.images[1].alt || displayName}
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
            <div className="w-full h-full flex items-center justify-center bg-muted text-muted-foreground">
              <PlaceholderImageIcon className="w-20 h-20" />
            </div>
          )}

          {/* Badges — sale + new only. Out-of-stock now uses the shared
              prominent red ribbon (OutOfStockRibbon below) to match the
              pecannbee/alkahraman target across every theme. */}
          <ProductBadgeGroup absolute position={isRtl ? 'top-right' : 'top-left'} isRtl={isRtl}>
            {discount > 0 && (
              <ProductBadge variant="sale" discount={discount} isRtl={isRtl} size="sm" />
            )}
            {product.isNew && <ProductBadge variant="new" isRtl={isRtl} size="sm" />}
          </ProductBadgeGroup>

          {/* Platform-level OOS ribbon (top-start, red, bold) — same visual
              treatment Ahmad shipped on PecannbeeProductCard, now in every
              theme via the shared component (2026-05-16). */}
          <OutOfStockRibbon inStock={product.inStock !== false} isRtl={isRtl} />

          {/* Per-card actions (compare / wishlist). When a card lives on the
            /wishlist page, `onRemoveFromWishlist` is provided; the "add to
            wishlist" heart is hidden to avoid a conflicting second action. */}
          {onToggleCompare && (
            <CompareButton
              productId={product.id}
              isInCompare={isInCompare}
              onToggle={onToggleCompare}
              isRtl={isRtl}
            />
          )}
          {onRemoveFromWishlist ? (
            <RemoveFromWishlistButton
              productId={product.id}
              onRemove={onRemoveFromWishlist}
              isRtl={isRtl}
            />
          ) : (
            <div
              className={cn(
                'absolute top-3 flex flex-col gap-2 transition-all duration-300',
                isRtl ? 'left-3' : 'right-3',
                // Always visible on touch; slides in on hover for pointer devices.
                'opacity-100 translate-x-0',
                'lg:opacity-0 lg:translate-x-3',
                isHovered && 'lg:opacity-100 lg:translate-x-0'
              )}
            >
              <button
                onClick={handleWishlist}
                className={cn(
                  'h-11 w-11 rounded-full flex items-center justify-center shadow-[0_8px_20px_-8px_hsl(var(--foreground)/0.30)] transition-all duration-300 ease-out cursor-pointer backdrop-blur-sm',
                  isWishlisted
                    ? 'bg-destructive text-destructive-foreground scale-[1.05]'
                    : 'bg-white/95 text-foreground hover:bg-white hover:scale-[1.05]'
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
          )}

          {/* Quick Add Button — always visible on touch; slides up on hover for pointer devices */}
          <div
            className={cn(
              'absolute bottom-0 inset-x-0 transition-all duration-300 ease-out',
              'opacity-100 translate-y-0',
              'lg:opacity-0 lg:translate-y-full',
              isHovered && 'lg:opacity-100 lg:translate-y-0'
            )}
            onClick={e => e.preventDefault()}
          >
            <div className="bg-gradient-to-t from-black/50 via-black/20 to-transparent pt-8 px-3 pb-3">
              {/* Platform-level dual CTA — products with variants show
                  "View" → PDP; single-variant products keep the inline
                  AddToCart. See templates/shared/ProductCardCta.tsx and
                  2026-05-16-mobile-ui-ship.md. */}
              <ProductCardCta
                productId={product.id}
                inStock={product.inStock !== false}
                hasVariants={!!product.variants && product.variants.length > 0}
                viewHref={`${urlPrefix}/products/${product.slug}`}
                quantityInCart={quantityInCart}
                isRtl={isRtl}
                onAddToCart={handleAddToCart}
                className="w-full py-2.5 text-sm font-semibold rounded-lg inline-flex items-center justify-center bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
              />
            </div>
          </div>
        </div>

        {/* Content — PC-2: pad driven by textSizes.pad from getProductCardTextSizes.
            PC-1: name and price sizes driven by textSizes.name / textSizes.price. */}
        <div className={`${textSizes.pad} flex flex-col gap-2 flex-1`}>
          {product.rating !== undefined && (
            <Rating
              value={product.rating}
              count={product.reviewCount}
              size="sm"
              isRtl={isRtl}
              showCount
            />
          )}

          {showLabel !== false && (nameVisible || priceVisible) && (
            <>
              {nameVisible && (
                <h3
                  id={`prod-${product.id}-name`}
                  data-zone="productName"
                  className={`font-semibold ${textSizes.name} text-foreground group-hover:text-primary transition-colors duration-300 ease-out line-clamp-2 leading-snug tracking-tight ${isRtl ? 'text-right' : ''}`}
                  itemProp="name"
                >
                  {isRtl && product.nameAr ? product.nameAr : product.name}
                </h3>
              )}
              {priceVisible && (
                <div className="mt-auto pt-1 tabular-nums">
                  <span itemProp="offers" itemScope itemType="https://schema.org/Offer">
                    <meta itemProp="priceCurrency" content={currency} />
                    <meta itemProp="price" content={String(product.price / 1000)} />
                  </span>
                  <Price
                    price={product.price}
                    compareAtPrice={product.compareAtPrice}
                    currency={currency}
                    isRtl={isRtl}
                    size="md"
                    showDiscount={false}
                    className={textSizes.price}
                  />
                  <TaxInclusiveLabel className="mt-1 block text-xs text-muted-foreground" />
                </div>
              )}
            </>
          )}
        </div>
      </Link>
    </article>
  );
}

export default memo(ModernProductCard, productCardPropsEqual);
