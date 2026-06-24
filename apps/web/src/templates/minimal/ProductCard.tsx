'use client';

import { memo } from 'react';
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
import { Price } from '@force/ui';
import { TaxInclusiveLabel } from '../shared/tax-inclusive-label';
import { productCardPropsEqual } from '../shared/product-card-memo';
import { getProductPricing } from '../../lib/product-pricing';
import { OutOfStockRibbon, ProductCardCta, isProductNew } from '../shared/ProductCardCta';
import { cn } from '@force/ui';

/**
 * Minimal Template - Product Card
 *
 * Apple-inspired: no borders, no shadows, no badges.
 * aspect-[3/4] image, huge whitespace, name + price only.
 * Hover: subtle opacity fade on image only.
 */
function MinimalProductCard({
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

  // Variant-aware pricing — see lib/product-pricing.ts.
  const pricing = getProductPricing(product, undefined, 'card');
  const hasSale = !!pricing.displayCompare || pricing.hasVariantDiscount;
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
        className="group block cursor-pointer"
      >
        {/* Image — PC-3: aspect driven by cardShape/cardAspect; falls back to
            mobile-square / desktop-portrait theme default. */}
        <div
          className={`relative overflow-hidden bg-muted/30 mb-3 ${imgRadiusCls || shape.radius} ${imgAspectCls || aspectOverride || 'aspect-square sm:aspect-[3/4]'}`}
        >
          {/* Platform-level OOS ribbon — minimal pack stays chrome-free
              elsewhere, but the OOS state needs unambiguous communication
              regardless of pack philosophy (2026-05-16).
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
          {/* Sprint 2 (2026-05-17): NEW badge in minimal kept extra-quiet
              (no shadow, tight padding, primary color via theme token)
              so it doesn't violate the chrome-free identity but still
              flags fresh inventory. Hides under OOS via isProductNew
              implicit gating in caller order. */}
          {product.inStock !== false && isProductNew(product) && (
            <span
              className="absolute top-2 start-2 z-10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-[hsl(var(--primary))] bg-background"
              aria-label={isRtl ? 'منتج جديد' : 'New product'}
            >
              {isRtl ? 'جديد' : 'NEW'}
            </span>
          )}
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
                className={`w-full h-full object-cover transition-opacity duration-700 ease-out ${
                  showHover !== false && product.images[1]?.url
                    ? 'group-hover:opacity-0'
                    : 'group-hover:opacity-85'
                }`}
                style={normalizeImages ? { objectFit: 'cover' } : undefined}
                fill
                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                priority={priority}
              />
              {/* Second image revealed on hover (≥2 images + showHover on). */}
              {showHover !== false && product.images[1]?.url && (
                <Image
                  src={product.images[1].url}
                  alt={isRtl && product.nameAr ? product.nameAr : product.name}
                  className="absolute inset-0 w-full h-full object-cover opacity-0 group-hover:opacity-100 transition-opacity duration-700 ease-out"
                  style={normalizeImages ? { objectFit: 'cover' } : undefined}
                  fill
                  sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                  loading="lazy"
                />
              )}
            </>
          ) : (
            <div className="w-full h-full flex items-center justify-center text-muted-foreground/20">
              <svg
                className="w-10 h-10"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={0.5}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
            </div>
          )}

          {/* Desktop hover-only quick-add — minimal stays chrome-free by
              default (no button visible). On lg+ pointer devices the
              CTA fades in over the image bottom on hover. Mobile (no
              hover) shows nothing — customers tap the card to land on
              PDP. Compromise per Ahmad 2026-05-16: 'desktop converts
              faster, mobile stays pure'. Text-only underlined link
              vocabulary matches minimal's font-light tracking-[0.2em]
              language. */}
          <div
            className={cn(
              'flex absolute bottom-0 inset-x-0 items-center justify-center pb-4 pt-12',
              'bg-gradient-to-t from-background/95 via-background/70 to-transparent',
              // Mobile: the underlined add-link is always tappable (no hover to
              // reveal). Desktop: keep the on-hover reveal — "mobile stays pure"
              // still holds visually, mobile just gains a tap-to-add affordance.
              'opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity duration-500 ease-out'
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
              variant="ghost"
              className={cn(
                'bg-transparent text-[10px] tracking-[0.28em] uppercase font-light text-foreground',
                'underline underline-offset-4 decoration-foreground/30 hover:decoration-foreground',
                'hover:bg-transparent hover:text-foreground transition-colors duration-300',
                'py-1 h-auto cursor-pointer'
              )}
              labels={{
                addToCart: isRtl ? 'أضف للسلة' : 'Add to Cart',
                addedToCart: isRtl ? 'تمت الإضافة' : 'Added',
                outOfStock: isRtl ? 'نفذت الكمية' : 'Sold Out',
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
            />
          </div>
        </div>

        {/* Text — PC-1: name/price sizes from textSizes; PC-2: pad from textSizes.pad. */}
        {showLabel !== false && (nameVisible || priceVisible) && (
          <div
            className={`flex flex-col gap-2 ${textSizes.pad} ${isRtl ? 'text-right' : 'text-left'}`}
          >
            {nameVisible && (
              <h3
                id={`prod-${product.id}-name`}
                data-zone="productName"
                className={`${textSizes.name} tracking-[0.18em] ${nameCase === 'uppercase' ? 'uppercase' : ''} font-light text-muted-foreground group-hover:text-foreground transition-colors duration-500 ease-out leading-snug`}
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
                className={`${textSizes.price} tracking-wide font-light text-muted-foreground tabular-nums`}
              />
            )}
            {/* Discount indicator — minimal pack stays chrome-free, so use a
              short uppercase 'sale' label inline rather than a badge box. */}
            {priceVisible && hasSale && (
              <p className="text-[10px] tracking-[0.25em] uppercase text-foreground/80">
                {isRtl ? 'تخفيض' : 'Sale'}
              </p>
            )}
            {priceVisible && (
              <TaxInclusiveLabel className="block text-[10px] tracking-wide font-light text-muted-foreground/70" />
            )}
          </div>
        )}
      </Link>
    </article>
  );
}

export default memo(MinimalProductCard, productCardPropsEqual);
