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
import { calculateDiscount } from '../shared/display-helpers';
import { PlaceholderImageIcon } from '../shared/icons';
import { TaxInclusiveLabel } from '../shared/tax-inclusive-label';
import { productCardPropsEqual } from '../shared/product-card-memo';
import { OosImageDim, ProductCardCta, OutOfStockRibbon } from '../shared/ProductCardCta';

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
  cardSize,
  cardAspect,
  cardShape,
  showLabel,
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
  showHover,
}: ProductCardProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const { store, layout } = useStore();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const [isHovered, setIsHovered] = useState(false);

  // PC-1/PC-2: derive name/price sizes and body padding from the canonical
  // helper so a single cardSize drives the whole card (2026-06-05).
  const textSizes = getProductCardTextSizes(cardSize);

  // PC-3: aspect override — cardShape named preset wins, then cardAspect enum,
  // then bold theme default (aspect-square per brand identity).
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

  const discount = calculateDiscount(product.price, product.compareAtPrice);
  // Task 13: backorder-aware orderable signal. OOS + backorder allowed → orderable.
  const orderable = product.inStock !== false || product.acceptsBackorder === true;

  const handleAddToCart = async (productId: string) => {
    await onAddToCart?.(productId);
  };

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
  // ctaMode: 'viewOnly' forces the View link for no-variant in-stock products too.
  const viewOnly = defaults?.ctaMode === 'viewOnly';

  return (
    <article
      itemScope
      itemType="https://schema.org/Product"
      aria-labelledby={`prod-${product.id}-name`}
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
        className="group block relative overflow-hidden rounded-2xl bg-background border-2 border-foreground/40 hover:border-foreground hover:translate-x-1 hover:-translate-y-1 hover:shadow-[6px_6px_0_0_hsl(var(--foreground)/0.92)] transition-all duration-200 ease-out cursor-pointer"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Image — PC-3: aspect driven by cardShape/cardAspect; bold theme
            default stays aspect-square to preserve the streetwear brand identity. */}
        <div
          className={`relative overflow-hidden bg-muted ${imgRadiusCls} ${imgAspectCls || aspectOverride || 'aspect-square'}`}
        >
          {/* Platform-level OOS ribbon (red, prominent) — same visual
              across every theme (2026-05-16).
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
                  'object-cover transition-all duration-300 ease-out',
                  isHovered && 'scale-[1.05]'
                )}
                style={{
                  ...(normalizeImages ? { objectFit: 'cover' } : {}),
                  opacity: isHovered && showHover !== false && product.images[1]?.url ? 0 : 1,
                }}
                fill
                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                priority={priority}
              />
              {/* Second image revealed on hover (≥2 images + showHover on). */}
              {showHover !== false && product.images[1]?.url && (
                <Image
                  src={product.images[1].url}
                  alt={isRtl && product.nameAr ? product.nameAr : product.name}
                  className={cn(
                    'absolute inset-0 object-cover transition-all duration-300 ease-out',
                    isHovered && 'scale-[1.05]'
                  )}
                  style={{
                    ...(normalizeImages ? { objectFit: 'cover' } : {}),
                    opacity: isHovered ? 1 : 0,
                  }}
                  fill
                  sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                  loading="lazy"
                />
              )}
            </>
          ) : (
            <div className="w-full h-full flex items-center justify-center text-muted-foreground/40">
              <PlaceholderImageIcon className="w-16 h-16" strokeWidth={1.5} />
            </div>
          )}

          {/* Image overlay tint when out-of-stock. z-[5] sits under the OOS
              badge (z-10) and above the product image. */}
          <OosImageDim
            orderable={orderable}
            oosDimColor={resolvedOosDimColor}
            theme={store.theme}
          />

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
            {/* Task 3 B2: thread CTA customization props. */}
            <ProductCardCta
              productId={product.id}
              inStock={orderable}
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
              ctaShape={resolvedCtaShape}
              ctaSize={resolvedCtaSize}
              ctaColor={resolvedCtaColor}
              ctaTextColor={resolvedCtaTextColor}
              ctaLabelTextEn={resolvedCtaLabelTextEn}
              ctaLabelTextAr={resolvedCtaLabelTextAr}
              oosDimColor={resolvedOosDimColor}
              theme={store.theme}
              viewOnly={viewOnly}
            />
          </div>
        </div>

        {/* Content — PC-1: name/price sizes from textSizes; PC-2: pad from textSizes.pad. */}
        {showLabel !== false && (nameVisible || priceVisible) && (
          <div className={`flex flex-col gap-2 ${textSizes.pad}`}>
            {nameVisible && (
              <h3
                id={`prod-${product.id}-name`}
                data-zone="productName"
                className={`font-black ${textSizes.name} ${nameCase === 'uppercase' ? 'uppercase' : ''} tracking-tight line-clamp-1 min-h-[1.5em] group-hover:text-primary transition-colors duration-200`}
                itemProp="name"
              >
                {isRtl && product.nameAr ? product.nameAr : product.name}
              </h3>
            )}
            {/* schema meta always rendered for SEO */}
            <span itemProp="offers" itemScope itemType="https://schema.org/Offer">
              <meta itemProp="priceCurrency" content={currency} />
              <meta itemProp="price" content={String(product.price / 1000)} />
            </span>
            {priceVisible && (
              <Price
                price={product.price}
                compareAtPrice={product.compareAtPrice}
                currency={currency}
                isRtl={isRtl}
                size="lg"
                showDiscount={false}
                className={`font-black tabular-nums ${textSizes.price}`}
              />
            )}
            {priceVisible && (
              <TaxInclusiveLabel className="block text-xs uppercase tracking-wide text-muted-foreground" />
            )}
          </div>
        )}
      </Link>
    </article>
  );
}

export default memo(BoldProductCard, productCardPropsEqual);
