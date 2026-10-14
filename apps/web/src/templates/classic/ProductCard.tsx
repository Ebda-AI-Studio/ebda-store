'use client';

import { memo } from 'react';
import { resolveProductCardCtaOosDefaults } from '../shared/product-card-defaults';
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
  lookImageAspectClass,
  cardImageRadiusClass,
} from '../shared/card-size';
import { useLanguage } from '../../contexts/LanguageContext';
import { useStore } from '../../contexts/StoreContext';
import {
  resolveColor,
  getProductCardTextSizes,
  fromMinor,
  REGION,
  storeNumerals,
} from '@force/shared';
import { CompareButton, RemoveFromWishlistButton } from '../shared/card-actions';
import { Price, ProductBadge, cn } from '@force/ui';
import { PlaceholderImageIcon } from '../shared/icons';
import { TaxInclusiveLabel } from '../shared/tax-inclusive-label';
import { productCardPropsEqual } from '../shared/product-card-memo';
import { getProductPricing, getDiscountBadgeText } from '../../lib/product-pricing';
import { OosImageDim, ProductCardCta, OutOfStockRibbon } from '../shared/ProductCardCta';
import { getDiscountBadgeColor } from '../shared/discount-badge';
import {
  getCustomBadgeColor,
  getCustomBadgeTextColor,
  resolveCardBadges,
} from '../shared/custom-badge';

/**
 * Classic Template - Product Card
 *
 * Clean square grid card — solid border, subtle shadow on hover, aspect-square
 * image, serif name, classic price. No lift animation; border color change
 * + gentle image zoom on hover.
 */
function ClassicProductCard({
  product,
  isRtl: isRtlProp,
  currency = REGION.currency,
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
  // Ruling NUMERALS-1: Western digits unless the store opted in (Arabic only).
  const numerals = storeNumerals(store?.theme);
  const isRtl = isRtlProp ?? ctxIsRtl;
  const handleAddToCart = async (productId: string) => {
    await onAddToCart?.(productId);
  };

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
  // BUG 1 fix: use helper for correct EGP/pct badge text.
  const discountBadgeText = getDiscountBadgeText(product, isRtl, undefined, undefined, numerals);
  // Task 13: backorder-aware orderable signal. OOS + backorder allowed → orderable.
  const orderable = product.inStock !== false || product.acceptsBackorder === true;

  const frameCls =
    `${cardFrameClass(showCardFrame, cardFrameStyle)} ${showCardFrame ? cardFrameWidthClass(cardFrameWidth) : ''} ${showCardFrame ? cardFrameSizeClass(cardFrameSize) : ''}`.trim();

  // Task 3 B: read CTA + OOS defaults from productCardDefaults.
  const defaults = layout?.productCardDefaults;
  const {
    resolvedCtaShape,
    resolvedCtaSize,
    resolvedCtaColor,
    resolvedCtaTextColor,
    resolvedCtaLabelTextEn,
    resolvedCtaLabelTextAr,
    resolvedOosDimColor,
    resolvedOosLabel,
    resolvedOosLabelTextEn,
    resolvedOosLabelTextAr,
    resolvedOosLabelShape,
    resolvedOosLabelPlacement,
    resolvedOosLabelColor,
    resolvedOosLabelTextColor,
    nameCase,
    viewOnly,
  } = resolveProductCardCtaOosDefaults(layout);
  // Discount/sale + custom badge — merchant-configurable corner + color.
  // `resolveCardBadges` is the SINGLE owner of both chips' final render
  // corner (issues #1609/#1611/#548): it suppresses the custom badge when
  // the product isn't orderable, suppresses the DISCOUNT badge when both
  // would land on the same physical corner, and moves either chip off
  // whichever corner the compare / remove-from-wishlist button occupies
  // (classic has no add-to-wishlist heart), and off the bottom band the
  // mobile quick-add CTA always renders.
  const discountBadgeColor = getDiscountBadgeColor(defaults?.discountBadge?.color, store.theme);
  const customBadgeColor = getCustomBadgeColor(defaults?.customBadge?.color, store.theme);
  const customBadgeTextColor = getCustomBadgeTextColor(defaults?.customBadge?.color, store.theme);
  const {
    customBadgeText,
    discountBadgeAllowed,
    customBadgePositionCls,
    discountBadgePositionCls,
  } = resolveCardBadges({
    discountVisible: Boolean(hasSale && discountBadgeText),
    product,
    isRtl,
    orderable,
    customPosition: defaults?.customBadge?.position,
    discountPosition: defaults?.discountBadge?.position,
    // Issue #1998 — top-corner sale badge unless the store keeps the legacy
    // bottom-left corner (per-store StoreTheme DATA, never a slug check).
    saleBadgeTopCorner: store.theme?.saleBadgeLegacyCorner !== true,
    topStartReserved: Boolean(onToggleCompare),
    topEndReserved: Boolean(onRemoveFromWishlist),
    // Issue #1997 — classic's NEW badge (below) only ever renders instead
    // of the sale badge (`!hasSale`), at logical top-start; mirror that
    // exact condition so a badge avoiding a reserved heart corner doesn't
    // land on top of it.
    newOrBrandBadgeReserved: Boolean(!hasSale && product.isNew && orderable),
    // The mobile quick-add CTA band below is an unconditional full-width
    // overlay (hidden only via a `lg:` desktop hover state, never removed
    // from the DOM), so it reserves the whole bottom edge.
    bottomOverlay: 'both',
  });

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
        {/* Image container — PC-3: aspect driven by cardShape/cardAspect;
            falls back to mobile-square / desktop-portrait theme default. */}
        <div
          className={`relative overflow-hidden bg-muted border border-border group-hover:border-foreground/35 group-hover:shadow-[0_18px_36px_-22px_hsl(var(--foreground)/0.20)] transition-[border-color,box-shadow] duration-500 ease-out mb-3 ${imgRadiusCls || shape.radius} ${imgAspectCls || aspectOverride || lookImageAspectClass(store.look) || 'aspect-square sm:aspect-[3/4]'}`}
        >
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
                alt={
                  product.images[0].alt || (isRtl && product.nameAr ? product.nameAr : product.name)
                }
                className={`w-full h-full object-cover group-hover:scale-[1.04] transition-[opacity,transform] duration-700 ease-out ${
                  showHover !== false && product.images[1]?.url ? 'group-hover:opacity-0' : ''
                }`}
                style={normalizeImages ? { objectFit: 'cover' } : undefined}
                fill
                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                priority={priority}
              />
              {/* Second image revealed on hover when the product has ≥2 images
                  and the merchant hasn't disabled it (showHover). */}
              {showHover !== false && product.images[1]?.url && (
                <Image
                  src={product.images[1].url}
                  alt={
                    product.images[1].alt ||
                    (isRtl && product.nameAr ? product.nameAr : product.name)
                  }
                  className="absolute inset-0 w-full h-full object-cover opacity-0 group-hover:opacity-100 group-hover:scale-[1.04] transition-[opacity,transform] duration-700 ease-out"
                  style={normalizeImages ? { objectFit: 'cover' } : undefined}
                  fill
                  sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
                  loading="lazy"
                />
              )}
            </>
          ) : (
            <div className="w-full h-full flex items-center justify-center text-muted-foreground/40">
              <PlaceholderImageIcon />
            </div>
          )}

          {/* Quick add overlay — always visible on touch; slides up on hover for pointer devices.
            Without this, mobile users couldn't reach the quick-add affordance at all. */}
          <div
            className="absolute bottom-0 inset-x-0 bg-foreground/90 py-3 translate-y-0 lg:translate-y-full lg:group-hover:translate-y-0 transition-transform duration-300 ease-out"
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
                'text-background font-serif text-xs tracking-widest uppercase w-full cursor-pointer',
                'hover:text-primary hover:bg-transparent transition-colors duration-200',
                'py-0 h-auto inline-flex items-center justify-center'
              )}
              labels={{
                addToCart: isRtl ? 'أضف للسلة' : 'Add to Bag',
                addedToCart: isRtl ? 'تمت الإضافة' : 'Added',
                outOfStock: isRtl ? 'نفذت الكمية' : 'Sold Out',
                adding: isRtl ? 'جاري الإضافة...' : 'Adding...',
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

          {/* Badges — top corner for "new"; sale badge wins over "new" when
              both apply. BUG 1 fix: label comes from helper (EGP or pct).
              BUG 2 fix: no inStock gate. Sale badge corner + color are
              merchant-configurable via productCardDefaults.discountBadge
              (physical; unset = top corner, or bottom-left when theme.saleBadgeLegacyCorner, #1998). */}
          {hasSale && discountBadgeAllowed && discountBadgeText ? (
            <span
              className={cn(
                'pointer-events-none absolute z-10 rounded-full px-2.5 py-1 text-xs font-semibold font-serif tracking-widest uppercase text-white shadow-[0_8px_20px_-8px_hsl(var(--destructive)/0.35)]',
                discountBadgePositionCls
              )}
              style={{ backgroundColor: discountBadgeColor }}
            >
              {discountBadgeText}
            </span>
          ) : (
            !hasSale &&
            product.isNew &&
            orderable && (
              <ProductBadge
                variant="new"
                isRtl={isRtl}
                size="sm"
                absolute
                position={isRtl ? 'top-right' : 'top-left'}
                className="font-serif tracking-widest uppercase bg-foreground text-background rounded-none text-[10px]"
                label={isRtl ? 'جديد' : 'New'}
              />
            )
          )}
          {/* Custom badge — merchant's own words (Product.badgeLabel/-Ar),
              rendered in classic's serif badge idiom so it reads as native.
              Only the corner + color differ from the sale chip above. */}
          {customBadgeText && (
            <span
              className={cn(
                'pointer-events-none absolute z-10 rounded-full px-2.5 py-1 text-xs font-semibold font-serif tracking-widest uppercase text-white shadow-[0_8px_20px_-8px_hsl(var(--foreground)/0.35)]',
                customBadgePositionCls
              )}
              style={{ backgroundColor: customBadgeColor, color: customBadgeTextColor }}
            >
              {customBadgeText}
            </span>
          )}
          {/* Platform-level OOS ribbon (red, prominent) — replaces the
              theme-local soldOut badge for visual consistency across
              every theme (2026-05-16).
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
            topStartReserved={Boolean(onToggleCompare)}
            topEndReserved={Boolean(onRemoveFromWishlist)}
          />
          {/* Image overlay tint when out-of-stock. z-[5] sits under the OOS
              badge (z-10) and above the product image. */}
          <OosImageDim
            orderable={orderable}
            oosDimColor={resolvedOosDimColor}
            theme={store.theme}
          />
        </div>

        {/* Product info — PC-1: name/price sizes from textSizes; PC-2: pad from textSizes.pad. */}
        {showLabel !== false && (nameVisible || priceVisible) && (
          <div
            className={`text-center flex flex-col gap-2 ${textSizes.pad} ${isRtl ? 'direction-rtl' : ''}`}
          >
            {nameVisible && (
              <h3
                id={`prod-${product.id}-name`}
                data-zone="productName"
                className={`font-serif ${textSizes.name} text-foreground mb-2 group-hover:text-primary transition-colors duration-500 leading-snug tracking-tight line-clamp-2 min-h-[2.5em]${nameCase === 'uppercase' ? ' uppercase' : ''}`}
                itemProp="name"
              >
                {isRtl && product.nameAr ? product.nameAr : product.name}
              </h3>
            )}
            {/* schema meta always rendered for SEO */}
            <span itemProp="offers" itemScope itemType="https://schema.org/Offer">
              <meta itemProp="priceCurrency" content={currency} />
              <meta itemProp="price" content={String(fromMinor(pricing.displayPrice))} />
            </span>
            {priceVisible && (
              <Price
                price={pricing.displayPrice}
                compareAtPrice={pricing.displayCompare ?? undefined}
                fromPrefix={pricing.mode === 'fromMin'}
                currency={currency}
                isRtl={isRtl}
                numerals={numerals}
                size="sm"
                showDiscount={false}
                className={`justify-center font-serif text-muted-foreground tabular-nums ${textSizes.price}`}
              />
            )}
            {priceVisible && (
              <TaxInclusiveLabel className="mt-1 block font-serif text-xs text-muted-foreground/70" />
            )}
          </div>
        )}
      </Link>
    </article>
  );
}

export default memo(ClassicProductCard, productCardPropsEqual);
