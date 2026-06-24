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
import type { CtaShape, CtaSize } from '../shared/card-size';
import { useLanguage } from '../../contexts/LanguageContext';
import { useStore } from '../../contexts/StoreContext';
import { resolveColor, getProductCardTextSizes } from '@force/shared';
import { CompareButton, RemoveFromWishlistButton } from '../shared/card-actions';
import { Price, ProductBadge, ProductBadgeGroup, cn } from '@force/ui';
import { PlaceholderImageIcon } from '../shared/icons';
import { TaxInclusiveLabel } from '../shared/tax-inclusive-label';
import { productCardPropsEqual } from '../shared/product-card-memo';
import { getProductPricing } from '../../lib/product-pricing';
import { ProductCardCta, OutOfStockRibbon } from '../shared/ProductCardCta';

/**
 * Elegant Template - Product Card
 *
 * Luxury fashion aesthetic: no borders, portrait aspect ratio, ultra-subtle
 * hover states. Uses shared components from @force/ui.
 */
function ElegantProductCard({
  product,
  isRtl: isRtlProp,
  currency = 'KWD',
  quantityInCart = 0,
  onAddToCart,
  onAddToWishlist,
  urlPrefix = '',

  isInCompare = false,

  onToggleCompare,

  onRemoveFromWishlist,
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
  priority,
  // Items 8/9
  cardImageAspect,
  cardImageRadius,
  showCardName,
  showCardPrice,
}: ProductCardProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const { store, layout } = useStore();
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

  // Item 8 — per-card image aspect + radius.
  const imgAspectCls = cardImageAspectClass(cardImageAspect);
  const imgRadiusCls = cardImageRadiusClass(cardImageRadius);
  // Items 6 / 9 — price + name visibility.
  // Single price-visibility control: productCardDefaults.showCardPrice
  // (the legacy theme.showPriceOnCards toggle was redundant and removed).
  const priceVisible =
    (showCardPrice ?? layout?.productCardDefaults?.showCardPrice) !== false &&
    store.theme?.showPriceOnCards !== false;
  const nameVisible = showCardName !== false;
  // Item 10 — normalize images.
  const normalizeImages = store.theme?.normalizeProductImages === true;

  const handleAddToCart = async (productId: string) => {
    await onAddToCart?.(productId);
  };

  const handleWishlist = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsWishlisted(prev => !prev);
    onAddToWishlist?.(product.id);
  };

  // Variant-aware pricing — for multi-variant products the headline
  // becomes "From <cheapest>" and the parent's stale compareAtPrice is
  // ignored. See lib/product-pricing.ts.
  const pricing = getProductPricing(product, undefined, 'card');
  const hasSale = !!pricing.displayCompare || pricing.hasVariantDiscount;
  // Task 13: backorder-aware orderable signal. OOS + backorder allowed → orderable.
  const orderable = product.inStock !== false || product.acceptsBackorder === true;

  const frameCls =
    `${cardFrameClass(showCardFrame, cardFrameStyle)} ${showCardFrame ? cardFrameWidthClass(cardFrameWidth) : ''} ${showCardFrame ? cardFrameSizeClass(cardFrameSize) : ''}`.trim();

  // Task 3 B: read CTA + OOS defaults from productCardDefaults.
  const defaults = layout?.productCardDefaults;
  const resolvedCtaShape = defaults?.ctaShape as CtaShape | undefined;
  const resolvedCtaSize = defaults?.ctaSize as CtaSize | undefined;
  const resolvedCtaColor = defaults?.ctaColor;
  const resolvedCtaTextColor = defaults?.ctaTextColor;
  const resolvedCtaLabelTextEn = defaults?.ctaLabelTextEn;
  const resolvedCtaLabelTextAr = defaults?.ctaLabelTextAr;
  const resolvedOosDimColor = defaults?.oosDimColor;
  const resolvedOosLabel = defaults?.oosLabel;
  const resolvedOosLabelTextEn = defaults?.oosLabelTextEn;
  const resolvedOosLabelTextAr = defaults?.oosLabelTextAr;
  const resolvedOosLabelShape = defaults?.oosLabelShape as CtaShape | undefined;
  const resolvedOosLabelPlacement = defaults?.oosLabelPlacement;
  const resolvedOosLabelColor = defaults?.oosLabelColor;
  const resolvedOosLabelTextColor = defaults?.oosLabelTextColor;
  // Task 6: merchant-controlled name casing (default = normal, no forced caps).
  const nameCase = layout?.productCardDefaults?.productNameCase;

  return (
    <article
      itemScope
      itemType="https://schema.org/Product"
      aria-labelledby={`prod-${product.id}-name`}
      // Task 3 Part A: article is relative so the absolute wishlist button
      // positioned here is never clipped by the image div's overflow-hidden.
      className={`relative w-full mx-auto ${productSizeClass(cardSize)} ${frameCls}`.trim()}
      style={
        showCardFrame && cardFrameColor && store.theme
          ? { borderColor: resolveColor(cardFrameColor, store.theme) }
          : undefined
      }
    >
      {/* Wishlist heart — lifted OUT of the image div (Part A fix).
          Positioned on the article, which has no overflow-hidden, so image
          rounding never clips this button. Keeps the same corner visual. */}
      {!onRemoveFromWishlist && (
        <button
          onClick={handleWishlist}
          className={cn(
            'absolute top-4 z-20 p-2 min-h-[44px] min-w-[44px] flex items-center justify-center transition-all duration-300 cursor-pointer',
            isRtl ? 'left-4' : 'right-4',
            'opacity-100 lg:opacity-0',
            (isHovered || isWishlisted) && 'lg:opacity-100'
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
      )}

      <Link
        href={`${urlPrefix}/products/${product.slug}`}
        // RSC prefetch on every product card in a long grid hammered the API's
        // publicLimiter (60/min/IP cap was tripping on routine browse — see
        // mobile audit 2026-05-13 + security.ts publicLimiter bump). prefetch
        // on hover/tap instead keeps PDP nav fast for *intended* clicks
        // without firing N prefetches just from a customer scrolling past.
        prefetch={false}
        className="group block cursor-pointer"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Image — fashion portrait ratio.
            PC-3: aspect driven by cardShape/cardAspect; falls back to
            mobile-square / desktop-portrait theme default. */}
        <div
          className={`relative overflow-hidden bg-gray-50 mb-3 ${imgRadiusCls || shape.radius} ${imgAspectCls || aspectOverride || 'aspect-square sm:aspect-[3/4]'}`}
        >
          {/* Platform-level OOS ribbon (red, prominent) — same visual
              across every theme, see templates/shared/ProductCardCta.tsx.
              Task 3 B4: OOS badge customization via productCardDefaults. */}
          <OutOfStockRibbon
            inStock={orderable}
            isRtl={isRtl}
            oosLabel={resolvedOosLabel}
            oosLabelTextEn={resolvedOosLabelTextEn}
            oosLabelTextAr={resolvedOosLabelTextAr}
            oosLabelShape={resolvedOosLabelShape}
            oosLabelPlacement={resolvedOosLabelPlacement}
            oosLabelColor={resolvedOosLabelColor}
            oosLabelTextColor={resolvedOosLabelTextColor}
            theme={store.theme}
          />
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
                  opacity: isHovered && showHover !== false && product.images[1]?.url ? 0 : 1,
                  transition: 'opacity 500ms, filter 500ms, transform 500ms',
                  ...(normalizeImages ? { objectFit: 'cover' } : {}),
                }}
                fill
                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                priority={priority}
              />
              {showHover !== false && product.images[1]?.url && (
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

          {/* Quick Add — always visible on touch; slides up on hover for pointer devices.
              Task 3 B2: thread CTA customization props. */}
          <div
            className={cn(
              'absolute bottom-0 inset-x-0 bg-background/95 backdrop-blur-sm transition-all duration-300',
              'opacity-100 translate-y-0',
              'lg:opacity-0 lg:translate-y-full',
              isHovered && 'lg:opacity-100 lg:translate-y-0'
            )}
            onClick={e => e.preventDefault()}
          >
            <ProductCardCta
              productId={product.id}
              inStock={orderable}
              hasVariants={!!product.variants && product.variants.length > 0}
              viewHref={`${urlPrefix}/products/${product.slug}`}
              quantityInCart={quantityInCart}
              isRtl={isRtl}
              onAddToCart={handleAddToCart}
              variant="ghost"
              className={cn(
                'w-full py-4 text-[10px] tracking-[0.25em] uppercase font-normal rounded-none cursor-pointer',
                'hover:bg-foreground hover:text-background transition-colors duration-300'
              )}
              labels={{
                addToCart: isRtl ? 'أضف للسلة' : 'Add to Bag',
                addedToCart: isRtl ? 'تمت الإضافة' : 'Added',
                outOfStock: isRtl ? 'نفذت الكمية' : 'Sold Out',
                adding: isRtl ? 'جاري...' : 'Adding...',
                view: isRtl ? 'عرض' : 'View',
              }}
              ctaShape={resolvedCtaShape}
              ctaSize={resolvedCtaSize}
              ctaColor={resolvedCtaColor}
              ctaTextColor={resolvedCtaTextColor}
              ctaLabelTextEn={resolvedCtaLabelTextEn}
              ctaLabelTextAr={resolvedCtaLabelTextAr}
              oosDimColor={resolvedOosDimColor}
              theme={store.theme}
            />
          </div>
        </div>

        {/* Content — refined, centered.
            PC-1: name/price sizes from textSizes; PC-2: pad from textSizes.pad. */}
        {showLabel !== false && (nameVisible || priceVisible) && (
          <div className={`text-center flex flex-col gap-2 ${textSizes.pad}`}>
            {nameVisible && (
              <h3
                id={`prod-${product.id}-name`}
                data-zone="productName"
                className={`${textSizes.name} tracking-[0.15em] ${nameCase === 'uppercase' ? 'uppercase' : ''} text-foreground/80 group-hover:text-foreground transition-colors duration-300 line-clamp-1`}
                itemProp="name"
              >
                {isRtl && product.nameAr ? product.nameAr : product.name}
              </h3>
            )}
            {/* schema meta always rendered for SEO */}
            <span itemProp="offers" itemScope itemType="https://schema.org/Offer">
              <meta itemProp="priceCurrency" content={currency} />
              <meta itemProp="price" content={String(pricing.displayPrice / 1000)} />
            </span>
            {priceVisible && (
              <Price
                price={pricing.displayPrice}
                compareAtPrice={pricing.displayCompare ?? undefined}
                fromPrefix={pricing.mode === 'fromMin'}
                currency={currency}
                isRtl={isRtl}
                size="sm"
                showDiscount={false}
                className={`justify-center text-muted-foreground font-light tabular-nums ${textSizes.price}`}
              />
            )}
            {priceVisible && (
              <TaxInclusiveLabel className="block text-[10px] tracking-[0.2em] uppercase text-muted-foreground/60" />
            )}
          </div>
        )}
      </Link>
    </article>
  );
}

export default memo(ElegantProductCard, productCardPropsEqual);
