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
} from '@ebda/shared';
import { CompareButton, RemoveFromWishlistButton } from '../shared/card-actions';
import { Price } from '@ebda/ui';
import { TaxInclusiveLabel } from '../shared/tax-inclusive-label';
import { productCardPropsEqual } from '../shared/product-card-memo';
import { getProductPricing, getDiscountBadgeText } from '../../lib/product-pricing';
import {
  OosImageDim,
  OutOfStockRibbon,
  ProductCardCta,
  isProductNew,
} from '../shared/ProductCardCta';
import { getDiscountBadgeColor } from '../shared/discount-badge';
import {
  getCustomBadgeColor,
  getCustomBadgeTextColor,
  resolveCardBadges,
} from '../shared/custom-badge';
import { cn } from '@ebda/ui';
import { SwatchDots } from '../../components/commerce/SwatchDots';
import { FactChips } from '../../components/commerce/FactChips';

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
  // BUG 1 fix: use helper for correct EGP/pct text.
  const discountBadgeText = getDiscountBadgeText(product, isRtl, undefined, undefined, numerals);
  // Task 13: backorder-aware orderable signal. OOS + backorder allowed → orderable.
  const orderable = product.inStock !== false || product.acceptsBackorder === true;
  const handleAddToCart = async (productId: string) => {
    await onAddToCart?.(productId);
  };
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
  // Discount/sale badge — minimal's badge is inline text below the price
  // (no corner overlay by design, "minimal pack stays chrome-free"), so
  // only the merchant-configurable COLOR applies here; the position field
  // is a no-op for this theme. Unset color falls back to the platform
  // destructive/red default (matches the previous hardcoded text-red-600).
  const discountBadgeColor = getDiscountBadgeColor(defaults?.discountBadge?.color, store.theme);
  // Custom (merchant-authored) badge. Unlike the other four themes, minimal's
  // DISCOUNT indicator is inline text under the price with no corner at all,
  // so the two can never collide: `discountOccupiesCorner: false` keeps the
  // corner arm of the mutex from firing and stealing the discount text. The
  // OOS suppression arm still applies.
  const customBadgeColor = getCustomBadgeColor(defaults?.customBadge?.color, store.theme);
  const customBadgeTextColor = getCustomBadgeTextColor(defaults?.customBadge?.color, store.theme);
  const { customBadgeText, customBadgePositionCls } = resolveCardBadges({
    discountVisible: Boolean(discountBadgeText),
    product,
    isRtl,
    orderable,
    customPosition: defaults?.customBadge?.position,
    discountPosition: defaults?.discountBadge?.position,
    // Issue #1998 — top-corner sale badge unless the store keeps the legacy
    // bottom-left corner (per-store StoreTheme DATA, never a slug check).
    saleBadgeTopCorner: store.theme?.saleBadgeLegacyCorner !== true,
    discountOccupiesCorner: false,
    // Issues #1609/#1611/#548 — minimal has no add-to-wishlist heart, only
    // the optional compare (top-start) / remove-from-wishlist (top-end)
    // buttons, plus the unconditional desktop-hover quick-add band, which
    // is visible-by-default on mobile (`opacity-100 lg:opacity-0`) so it
    // reserves the whole bottom edge same as the other 4 themes.
    topStartReserved: Boolean(onToggleCompare),
    topEndReserved: Boolean(onRemoveFromWishlist),
    // Issue #2092 (#1997 sweep) — minimal's own NEW chip sits at logical
    // top-start; the SAME expression it renders on below.
    newOrBrandBadgeReserved: Boolean(product.inStock !== false && isProductNew(product)),
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
        className="group block cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        {/* Image — PC-3: aspect driven by cardShape/cardAspect; falls back to
            mobile-square / desktop-portrait theme default. */}
        <div
          className={`relative overflow-hidden bg-muted/30 mb-3 ${imgRadiusCls || shape.radius} ${imgAspectCls || aspectOverride || lookImageAspectClass(store.look) || 'aspect-square sm:aspect-[3/4]'}`}
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
          {/* Sprint 2 (2026-05-17): NEW badge in minimal kept extra-quiet
              (no shadow, tight padding, primary color via theme token)
              so it doesn't violate the chrome-free identity but still
              flags fresh inventory. Hides under OOS via isProductNew
              implicit gating in caller order. */}
          {product.inStock !== false && isProductNew(product) && (
            <span
              className="absolute top-2 start-2 z-10 px-2 py-0.5 text-xs font-medium uppercase tracking-[0.18em] text-[hsl(var(--primary))] bg-background"
              aria-label={isRtl ? 'منتج جديد' : 'New product'}
            >
              {isRtl ? 'جديد' : 'NEW'}
            </span>
          )}
          {/* Custom badge — merchant's own words (Product.badgeLabel/-Ar).
              Kept in minimal's extra-quiet badge idiom (no shadow, tight
              padding, micro-tracking) to match the NEW chip above rather than
              the loud chips the other packs use. It is a corner overlay even
              though minimal's discount indicator is inline text: this chip is
              merchant-authored promotional copy about the PRODUCT, not a
              price annotation, and the merchant chose its corner. It appears
              only when a label is typed, so the pack stays chrome-free by
              default. */}
          {customBadgeText && (
            <span
              className={cn(
                'pointer-events-none absolute z-10 px-2 py-0.5 text-xs font-medium uppercase tracking-[0.18em] text-white',
                customBadgePositionCls
              )}
              style={{ backgroundColor: customBadgeColor, color: customBadgeTextColor }}
            >
              {customBadgeText}
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
                alt={
                  product.images[0].alt || (isRtl && product.nameAr ? product.nameAr : product.name)
                }
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
                  alt={
                    product.images[1].alt ||
                    (isRtl && product.nameAr ? product.nameAr : product.name)
                  }
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
              'flex absolute bottom-0 inset-x-0 items-center justify-center px-3 pb-4 pt-12',
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
                'max-w-full overflow-hidden text-ellipsis bg-transparent text-xs tracking-[0.14em] uppercase font-normal text-foreground',
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
              viewOnly={viewOnly}
            />
          </div>
        </div>

        {/* Text — PC-1: name/price sizes from textSizes; PC-2: pad from textSizes.pad. */}
        {showLabel !== false && (nameVisible || priceVisible) && (
          <div className={`flex flex-col gap-2 ${textSizes.pad} text-start`}>
            {nameVisible && (
              <h3
                id={`prod-${product.id}-name`}
                data-zone="productName"
                className={`${textSizes.name} tracking-normal sm:tracking-[0.18em] ${nameCase === 'uppercase' ? 'uppercase' : ''} font-light text-muted-foreground group-hover:text-foreground transition-colors duration-500 ease-out leading-snug [overflow-wrap:anywhere] line-clamp-2 min-h-[2.5em]`}
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
                className={`${textSizes.price} tracking-wide font-light text-muted-foreground tabular-nums`}
              />
            )}
            {/* Discount indicator — minimal pack stays chrome-free, so use a
              short label inline (no corner overlay; the position field of
              productCardDefaults.discountBadge is a no-op here by design).
              BUG 1 fix: show helper text (EGP or pct).
              BUG 2 fix: shown even when OOS (no inStock gate). Color is
              merchant-configurable via productCardDefaults.discountBadge.color. */}
            {priceVisible && hasSale && discountBadgeText && (
              <p
                className="text-xs tracking-[0.25em] uppercase font-semibold"
                style={{ color: discountBadgeColor }}
              >
                {discountBadgeText}
              </p>
            )}
            {priceVisible && (
              <TaxInclusiveLabel className="block text-xs tracking-wide font-normal text-muted-foreground/70" />
            )}
            <SwatchDots product={product} max={5} />
            <FactChips product={product} className="mt-1" />
          </div>
        )}
      </Link>
    </article>
  );
}

export default memo(MinimalProductCard, productCardPropsEqual);
