'use client';

import { memo, useState } from 'react';
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
} from '@ebda/shared';
import { CompareButton, RemoveFromWishlistButton } from '../shared/card-actions';
import { Price, ProductBadge, ProductBadgeGroup, cn } from '@ebda/ui';
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
import { SwatchDots } from '../../components/commerce/SwatchDots';
import { FactChips } from '../../components/commerce/FactChips';

/**
 * Elegant Template - Product Card
 *
 * Luxury fashion aesthetic: no borders, portrait aspect ratio, ultra-subtle
 * hover states. Uses shared components from @ebda/ui.
 */
function ElegantProductCard({
  product,
  isRtl: isRtlProp,
  currency = REGION.currency,
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
  // Ruling NUMERALS-1: Western digits unless the store opted in (Arabic only).
  const numerals = storeNumerals(store?.theme);
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
  // BUG 1 fix: helper text for correct EGP/pct badge.
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
  // whichever corner the wishlist heart / compare button occupies, and off
  // the bottom band the mobile quick-add CTA always renders.
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
    // Compare button renders at top-start; elegant's wishlist heart — or
    // its wishlist-page substitute, RemoveFromWishlistButton — is
    // unconditional at top-end (unlike modern, not gated on onAddToWishlist).
    topStartReserved: Boolean(onToggleCompare),
    topEndReserved: true,
    // Issue #1997 — the NEW badge below renders at logical top-start under
    // this exact condition; a discount/custom badge avoiding a reserved
    // heart corner must not land on top of it.
    newOrBrandBadgeReserved: Boolean(orderable && product.isNew),
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
            'absolute top-4 z-20 p-2 min-h-[44px] min-w-[44px] flex items-center justify-center transition-opacity duration-300 cursor-pointer',
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
          className={`relative overflow-hidden bg-gray-50 mb-3 ${imgRadiusCls || shape.radius} ${imgAspectCls || aspectOverride || lookImageAspectClass(store.look) || 'aspect-square sm:aspect-[3/4]'}`}
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
            topStartReserved={Boolean(onToggleCompare)}
            topEndReserved
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
          {/* Image overlay tint when out-of-stock. z-[5] sits under the OOS
              badge (z-10) and above the product image. */}
          <OosImageDim
            orderable={orderable}
            oosDimColor={resolvedOosDimColor}
            theme={store.theme}
          />
          {product.images?.[0]?.url ? (
            <>
              <Image
                src={product.images[0].url}
                alt={
                  product.images[0].alt || (isRtl && product.nameAr ? product.nameAr : product.name)
                }
                className={cn(
                  'object-cover',
                  isHovered ? 'brightness-95 scale-[1.02]' : 'brightness-100 scale-100'
                )}
                style={{
                  opacity: isHovered && showHover !== false && product.images[1]?.url ? 0 : 1,
                  // Inline transition already covers opacity/filter/transform —
                  // the class-based transition-all this replaced was fully
                  // overridden by this inline style (higher specificity) and
                  // never actually applied; dropped as dead code.
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
                  alt={
                    product.images[1].alt ||
                    (isRtl && product.nameAr ? product.nameAr : product.name)
                  }
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

          {/* NEW badge — BUG 2 fix: no inStock gate removed from the group;
              NEW stays top corner, only shown when orderable (unchanged). */}
          {orderable && product.isNew && (
            <ProductBadgeGroup absolute position={isRtl ? 'top-right' : 'top-left'} isRtl={isRtl}>
              <ProductBadge
                variant="new"
                isRtl={isRtl}
                size="sm"
                className="text-[9px] tracking-[0.2em] uppercase rounded-none bg-foreground text-background font-normal"
                label={isRtl ? 'جديد' : 'New'}
              />
            </ProductBadgeGroup>
          )}
          {/* Sale badge — pulled OUT of the NEW badge group so only IT moves
              to the merchant-configured corner (physical; unset = top corner, or
              bottom-left when theme.saleBadgeLegacyCorner, #1998). BUG 1 fix: helper text.
              BUG 2 fix: no inStock gate. */}
          {hasSale && discountBadgeAllowed && discountBadgeText && (
            <span
              className={cn(
                'pointer-events-none absolute z-10 rounded-full px-2.5 py-1 text-[9px] font-normal tracking-[0.2em] uppercase text-white shadow-[0_8px_20px_-8px_rgba(220,38,38,0.45)]',
                discountBadgePositionCls
              )}
              style={{ backgroundColor: discountBadgeColor }}
            >
              {discountBadgeText}
            </span>
          )}
          {/* Custom badge — merchant's own words (Product.badgeLabel/-Ar),
              rendered in this theme's own badge idiom so it reads as native.
              Only the corner + color differ from the sale chip above. */}
          {customBadgeText && (
            <span
              className={cn(
                'pointer-events-none absolute z-10 rounded-full px-2.5 py-1 text-[9px] font-normal tracking-[0.2em] uppercase text-white shadow-[0_8px_20px_-8px_rgba(0,0,0,0.35)]',
                customBadgePositionCls
              )}
              style={{ backgroundColor: customBadgeColor, color: customBadgeTextColor }}
            >
              {customBadgeText}
            </span>
          )}

          {/* Quick Add — always visible on touch; slides up on hover for pointer devices.
              Task 3 B2: thread CTA customization props. */}
          <div
            className={cn(
              'absolute bottom-0 inset-x-0 bg-background/95 backdrop-blur-sm transition-[opacity,transform] duration-300',
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
                'w-full max-w-full overflow-hidden text-ellipsis px-2 py-4 text-[10px] tracking-[0.12em] sm:tracking-[0.25em] uppercase font-normal rounded-none cursor-pointer',
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
              viewOnly={viewOnly}
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
                className={`${textSizes.name} tracking-[0.15em] ${nameCase === 'uppercase' ? 'uppercase' : ''} text-foreground/80 group-hover:text-foreground transition-colors duration-300 [overflow-wrap:anywhere] line-clamp-1 min-h-[1.5em]`}
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
                className={`justify-center text-muted-foreground font-light tabular-nums ${textSizes.price}`}
              />
            )}
            {priceVisible && (
              <TaxInclusiveLabel className="block text-[10px] tracking-[0.2em] uppercase text-muted-foreground/60" />
            )}
            <SwatchDots product={product} max={5} className="justify-center" />
            <FactChips product={product} className="mt-1 justify-center" />
          </div>
        )}
      </Link>
    </article>
  );
}

export default memo(ElegantProductCard, productCardPropsEqual);
