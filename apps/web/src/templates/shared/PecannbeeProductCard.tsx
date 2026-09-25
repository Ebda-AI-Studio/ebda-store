'use client';

import type React from 'react';
import { resolveProductCardDefaults } from './product-card-defaults';
import { memo, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import type { ProductCardProps } from '../types';
import type { TemplateId, ProductCardSize } from '@force/shared';
import { getProductCardTextSizes, resolveColor } from '@force/shared';
import { cn, CartIcon } from '@force/ui';
import { useLanguage } from '../../contexts/LanguageContext';
import { useStore } from '../../contexts/StoreContext';
import { useNumerals } from '../../hooks/useNumerals';
import { getPackStyles } from './pack-styles';
import {
  cardFrameClass,
  cardFrameSizeClass,
  cardFrameWidthClass,
  productSizeClass,
  cardAspectClass,
  cardShapeClasses,
  cardImageAspectClass,
  cardImageRadiusClass,
  ctaShapeClass,
  ctaSizeClass,
} from './card-size';
import { getProductPricing, getDiscountBadgeText, isOnSale } from '../../lib/product-pricing';
import { productCardPropsEqual } from './product-card-memo';
import { responsiveFontSize, guardedCtaColor } from './section-typography';
import { TaxInclusiveLabel } from './tax-inclusive-label';
import { OosImageDim, OutOfStockRibbon, isProductNew } from './ProductCardCta';
import { BrandPill } from './BrandPill';
import { getDiscountBadgeColor } from './discount-badge';
import { getCustomBadgeColor, resolveCardBadges } from './custom-badge';

interface PecannbeeProductCardProps extends ProductCardProps {
  pack?: TemplateId;
  /**
   * Per-card font-size scale, paired with the merchant's chosen card width
   * via `getProductCardTextSizes`. Pack-styles drives the FLAVOR (weight,
   * tracking, color); this drives SIZE responsively. Sprint 1 2026-05-17.
   */
  cardSize?: ProductCardSize;
}

/**
 * Pecannbee-spec product card used on the PLP grid (and any other surface
 * that wants the canonical card layout). Contract per spec § 4.3:
 *
 * ┌──────────────────────────┐
 * │ [♥]                  [-25%]│  ← wishlist top-START, sale/sold-out top-END
 * │                              │
 * │      square 1:1 image       │
 * │                              │
 * ├──────────────────────────┤
 * │ Product name (1–2 lines)    │
 * │ KD 5.000  KD 6.000        │
 * │ ┌────────────────────┐ │
 * │ │  Add to cart  🛒  │ │  ← full-width pill CTA
 * │ └────────────────────┘ │
 * └──────────────────────────┘
 *
 * Sold-out variant: ribbon + disabled bg-muted CTA.
 * Pack styling driven by `pack-styles.ts` so each template's voice survives.
 */
function PecannbeeProductCardImpl({
  product,
  isRtl: isRtlProp,
  currency = 'KWD',
  onAddToCart,
  onAddToWishlist,
  onRemoveFromWishlist,
  urlPrefix = '',
  pack,
  cardSize,
  cardAspect,
  cardShape,
  showCardFrame,
  cardFrameStyle,
  cardFrameWidth,
  cardFrameSize,
  cardFrameColor,
  showLabel,
  showHover,
  productNameZone,
  productPriceZone,
  productCtaZone,
  priority,
  // Items 8/9 — image controls + label visibility
  cardImageAspect,
  cardImageRadius,
  showCardName,
  showCardPrice,
}: PecannbeeProductCardProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const { store, layout } = useStore();
  const { localize } = useNumerals();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const styles = getPackStyles(pack);
  const textSizes = getProductCardTextSizes(cardSize);
  // Sprint 4 (2026-05-18): global card-defaults wiring so PLP / category /
  // search cards reflect the merchant's productCardDefaults settings.
  const sizeCap = productSizeClass(cardSize);
  const shape = cardShapeClasses(cardShape);
  const aspectOverride = shape.aspect || cardAspectClass(cardAspect);
  const frameCls =
    `${cardFrameClass(showCardFrame, cardFrameStyle)} ${showCardFrame ? cardFrameWidthClass(cardFrameWidth) : ''} ${showCardFrame ? cardFrameSizeClass(cardFrameSize) : ''}`.trim();
  const [isWishlisted, setIsWishlisted] = useState(false);
  const [isAdding, setIsAdding] = useState(false);

  // Item 8 — per-card image aspect + radius overrides.
  const imgAspectCls = cardImageAspectClass(cardImageAspect);
  const imgRadiusCls = cardImageRadiusClass(cardImageRadius);

  // Items 6 / 9 — price visibility: store-level master toggle + per-card flag.
  // Single price-visibility control: productCardDefaults.showCardPrice
  // (the legacy theme.showPriceOnCards toggle was redundant and removed).
  const priceVisible = showCardPrice !== false;

  // Item 9 — name visibility.
  const nameVisible = showCardName !== false;

  // Item 10 — image normalization flag. When on, object-fit: cover + neutral bg
  // ensure a uniform grid look regardless of source image proportions.
  const normalizeImages = store.theme?.normalizeProductImages === true;

  // Variant-aware pricing: use getProductPricing so hasVariants shows "From X"
  // and we don't show the parent's stale standalone price when variants exist.
  const pricing = getProductPricing(product, undefined, 'card');

  const inStock = product.inStock !== false;
  // Task 13: backorder-aware orderable signal. OOS products with backorder
  // allowed are still orderable — CTA stays pressable, no OOS label shown.
  const orderable = inStock || product.acceptsBackorder === true;
  const onSale = isOnSale(product);
  // BUG 1 fix: use getDiscountBadgeText so fixed-KWD discounts render correctly.
  const discountBadgeText = getDiscountBadgeText(product, isRtl);

  const name = isRtl && product.nameAr ? product.nameAr : product.name;
  const href = `${urlPrefix}/products/${product.slug}`;
  const img = product.images?.[0]?.url;

  const handleWishlist = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (onRemoveFromWishlist) {
      onRemoveFromWishlist(product.id);
      return;
    }
    setIsWishlisted(w => !w);
    onAddToWishlist?.(product.id);
  };

  const handleAdd = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!orderable || !onAddToCart) return;
    setIsAdding(true);
    try {
      await onAddToCart(product.id);
    } finally {
      setIsAdding(false);
    }
  };

  const showNewBadge = inStock && isProductNew(product);

  // Task 3 B: read CTA + OOS defaults from productCardDefaults.
  const defaults = layout?.productCardDefaults;
  const {
    ctaShape: resolvedCtaShape,
    ctaSize: resolvedCtaSize,
    ctaColor: resolvedCtaColor,
    ctaTextColor: resolvedCtaTextColor,
    ctaLabelTextEn: resolvedCtaLabelTextEn,
    ctaLabelTextAr: resolvedCtaLabelTextAr,
    oosDimColor: resolvedOosDimColor,
    oosLabel: resolvedOosLabel,
    oosLabelTextEn: resolvedOosLabelTextEn,
    oosLabelTextAr: resolvedOosLabelTextAr,
    oosLabelShape: resolvedOosLabelShape,
    oosLabelPlacement: resolvedOosLabelPlacement,
    oosLabelColor: resolvedOosLabelColor,
    oosLabelTextColor: resolvedOosLabelTextColor,
    nameCase,
    viewOnly,
  } = resolveProductCardDefaults(layout);
  // Discount/sale + custom badge — merchant-configurable corner + color.
  // `resolveCardBadges` is the SINGLE owner of both chips' final render
  // corner: it suppresses the custom badge when the product isn't
  // orderable, suppresses the DISCOUNT badge when both would land on the
  // same physical corner, and (issues #1609/#1611/#548) moves either chip
  // off whichever corner the wishlist heart occupies. `topStartReserved`
  // is always true here — PecannbeeProductCard's heart is the one theme
  // surface anchored at top-start (every other theme's heart, when it has
  // one, is top-end); there is no compare button on this card.
  const discountBadgeColor = getDiscountBadgeColor(defaults?.discountBadge?.color, store.theme);
  const customBadgeColor = getCustomBadgeColor(defaults?.customBadge?.color, store.theme);
  const {
    customBadgeText,
    discountBadgeAllowed,
    customBadgePositionCls,
    discountBadgePositionCls,
  } = resolveCardBadges({
    discountVisible: Boolean(onSale && discountBadgeText),
    product,
    isRtl,
    orderable,
    customPosition: defaults?.customBadge?.position,
    discountPosition: defaults?.discountBadge?.position,
    topStartReserved: true,
    // No bottom-band CTA overlay here — Pecannbee's Add-to-Cart button is a
    // normal block element below the name/price, not an image overlay.
    bottomOverlay: 'none',
  });

  // CTA shape + size classes (additive — '' when unset so pack styles win).
  const ctaExtraCls = [ctaShapeClass(resolvedCtaShape), ctaSizeClass(resolvedCtaSize)]
    .filter(Boolean)
    .join(' ');
  const resolvedBg =
    resolvedCtaColor && store.theme ? resolveColor(resolvedCtaColor, store.theme) : undefined;
  const resolvedText =
    resolvedCtaTextColor && store.theme
      ? resolveColor(resolvedCtaTextColor, store.theme)
      : undefined;

  return (
    <article
      // max-w cap on desktop so product cards in a 4-col grid don't
      // balloon to 300+px each. Mobile (2 cols, narrow viewport) doesn't
      // hit the cap. Ahmad 2026-05-16 'products as well' after the
      // category cap landed.
      // Sprint 2 (2026-05-17): hover-scale 1.02 + slow shadow lift for
      // a micro-payoff on desktop — addresses the friend complaint
      // 'product cards are static'. Mobile loses nothing (no hover state
      // to trigger). `group` enables the inner image scale below.
      // Task 3 Part A: overflow-hidden REMOVED from article so the absolute
      // wishlist heart (now a sibling of the Link, not inside the image div)
      // is never clipped by the article's rounded corners.
      // cn() (tailwind-merge) routes this concatenation so conflicting
      // frame-vs-pack utilities (rounded-*, border-*, bg-card, duration-*)
      // collapse to one winner instead of both landing in the DOM —
      // verified zero rendered-output change for the `showCardFrame` +
      // pack-style combination (see design-sweep PR).
      className={cn(
        'group relative flex flex-col w-full mx-auto transition-[transform,box-shadow] duration-[var(--duration-slow)] ease-[var(--ease-out)] md:hover:scale-[1.02] md:hover:shadow-[0_20px_40px_-20px_hsl(var(--foreground)/0.18)]',
        sizeCap || 'md:max-w-[200px]',
        frameCls,
        shape.radius,
        styles.card
      )}
      style={
        showCardFrame && cardFrameColor && store.theme
          ? { borderColor: resolveColor(cardFrameColor, store.theme) }
          : undefined
      }
      dir={isRtl ? 'rtl' : 'ltr'}
      itemScope
      itemType="https://schema.org/Product"
      aria-labelledby={`prod-${product.id}-name`}
    >
      {/* Wishlist heart — lifted OUT of the image div (Part A fix).
          Now a direct child of <article> which has no overflow-hidden,
          so rounded card shapes never clip this button.
          Keeps absolute top-3 start-3 z-20 so it sits at the same
          visual position as before. */}
      <button
        type="button"
        onClick={handleWishlist}
        aria-label={isRtl ? 'إضافة للمفضلة' : 'Add to wishlist'}
        aria-pressed={isWishlisted}
        // Touch hitbox: the visual circle stays 40px (h-10 w-10, unchanged),
        // but before:-inset-1.5 grows the actual tap target to ~52px so it
        // clears the 44px a11y floor without changing the rendered size.
        className={`before:absolute before:-inset-1.5 before:content-[''] absolute top-3 start-3 z-20 inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/95 backdrop-blur-sm shadow-[0_8px_20px_-8px_hsl(var(--foreground)/0.30)] transition-[transform,background-color,color] duration-[var(--duration-base)] ease-[var(--ease-out)] hover:scale-[1.05] hover:bg-white active:scale-95 cursor-pointer ${
          isWishlisted ? 'text-destructive' : 'text-foreground/70 hover:text-foreground'
        }`}
      >
        <svg
          className="h-5 w-5"
          fill={isWishlisted ? 'currentColor' : 'none'}
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
          />
        </svg>
      </button>

      <Link
        href={href}
        prefetch={false}
        className="group/img block focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      >
        {/* Image: item 8 — aspect+radius driven by per-store cardImageAspect/cardImageRadius;
            falls back to the mobile-square / desktop-portrait theme default. Item 10 —
            when normalizeImages is on, object-fill bg ensures transparent PNGs read cleanly.
            overflow-hidden STAYS on the image div so images still clip to the shape. */}
        <div
          className={`relative overflow-hidden bg-muted ${imgRadiusCls || shape.radius} ${imgAspectCls || aspectOverride || 'aspect-square sm:aspect-[3/4]'}`}
        >
          {img ? (
            <>
              <Image
                src={img}
                alt={product.images?.[0]?.alt ?? name}
                fill
                priority={priority}
                sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 200px"
                className={`${normalizeImages ? 'object-cover' : 'object-cover'} transition-opacity duration-[var(--duration-slow)] ${
                  showHover !== false && product.images?.[1]?.url ? 'group-hover/img:opacity-0' : ''
                }`}
                style={normalizeImages ? { objectFit: 'cover' } : undefined}
              />
              {showHover !== false && product.images?.[1]?.url && (
                <Image
                  src={product.images[1].url}
                  alt={product.images[1].alt ?? name}
                  fill
                  sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 200px"
                  loading="lazy"
                  className="absolute inset-0 object-cover opacity-0 transition-opacity duration-[var(--duration-slow)] group-hover/img:opacity-100"
                />
              )}
            </>
          ) : (
            <div className="flex h-full w-full items-center justify-center text-muted-foreground">
              <svg
                className="h-10 w-10"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                aria-hidden
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                />
              </svg>
            </div>
          )}

          {/* Sprint 2 (2026-05-17): replaced the inline OOS pill with the
              shared OutOfStockRibbon component — proper diagonal corner
              ribbon at -45°, consumed by all 5 themes already. NEW
              orange badge added below it (top-START) when product is
              flagged new OR was created in the last 14 days.
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
            // Issue #548 — same reservation as the badge mutex above: this
            // card's heart is at top-start, so an OOS pill left at its
            // top-start default must move off it, not just narrow in place.
            topStartReserved
          />
          {/* Image overlay tint when out-of-stock. z-[5] sits under the OOS
              badge (z-10) and above the product image. */}
          <OosImageDim
            orderable={orderable}
            oosDimColor={resolvedOosDimColor}
            theme={store.theme}
          />
          {showNewBadge && (
            <span
              className="absolute top-3 start-3 z-10 rounded-full bg-[hsl(var(--primary))] px-2.5 py-1 text-xs font-bold uppercase tracking-wider text-[hsl(var(--primary-foreground))] shadow-[0_6px_14px_-6px_hsl(var(--primary)/0.5)]"
              aria-label={isRtl ? 'منتج جديد' : 'New product'}
            >
              {isRtl ? 'جديد' : 'NEW'}
            </span>
          )}
          {/* Bucket C5: brand pill — hidden when OOS ribbon or NEW
              badge already occupies the top-START corner. */}
          <BrandPill hidden={!inStock || showNewBadge} />
          {/* Sale chip — always shown when on sale (BUG 1 + BUG 2 fix),
              both stock states. Corner + color are merchant-configurable
              via productCardDefaults.discountBadge (default bottom-left,
              physical — never mirrors with RTL). */}
          {onSale && discountBadgeAllowed && discountBadgeText && (
            <span
              className={cn(
                'absolute z-10 rounded-full px-2.5 py-1 text-xs font-semibold tracking-wide text-white shadow-[0_8px_20px_-8px_rgba(220,38,38,0.45)]',
                discountBadgePositionCls
              )}
              style={{ backgroundColor: discountBadgeColor }}
            >
              {discountBadgeText}
            </span>
          )}
          {/* Custom badge — merchant's own words (Product.badgeLabel/-Ar).
              Same chip geometry as the sale chip above so the two read as one
              system; only the corner + color differ. Renders only when the
              merchant typed something. */}
          {customBadgeText && (
            <span
              className={cn(
                'absolute z-10 rounded-full px-2.5 py-1 text-xs font-semibold tracking-wide text-white shadow-[0_8px_20px_-8px_rgba(0,0,0,0.35)]',
                customBadgePositionCls
              )}
              style={{ backgroundColor: customBadgeColor }}
            >
              {customBadgeText}
            </span>
          )}
        </div>
      </Link>

      {/* Card chrome tightened 2026-05-16 per ahmad 'products are too big':
          p-5/p-6 → p-3/p-4 (~10px smaller padding × 4 sides), gap-3 → gap-2,
          and dropped the min-h-[3em] name reservation so the card shrinks
          to whatever the actual content needs. Net effect: ~20-30px shorter
          per card on mobile, denser grid feel matches the pecannbee target. */}
      <div
        className={`flex flex-1 flex-col ${textSizes.gap} ${textSizes.pad} ${styles.productCardBody ?? ''}`}
      >
        {/* showLabel gates the entire name + price + tax block. When false the
            card shows image + CTA only — useful for icon-style catalog grids.
            Items 6/9: within the block, nameVisible (showCardName) and
            priceVisible (showPriceOnCards + showCardPrice) gate each sub-element
            independently so a merchant can show name-only or price-only. */}
        {showLabel !== false && (nameVisible || priceVisible) && (
          <>
            {nameVisible && (
              <Link
                href={href}
                prefetch={false}
                className="focus:outline-none focus-visible:underline"
              >
                <p
                  id={`prod-${product.id}-name`}
                  data-zone="productName"
                  className={`line-clamp-2 min-h-[2.5em] font-semibold ${textSizes.name} ${styles.productCardName}${nameCase === 'uppercase' ? ' uppercase' : ''}`}
                  style={{
                    textWrap: 'balance',
                    fontFamily: productNameZone?.fontFamily,
                    fontSize: responsiveFontSize(productNameZone?.fontSize),
                    fontWeight: productNameZone?.fontWeight,
                    color: productNameZone?.color,
                    letterSpacing: productNameZone?.letterSpacing,
                    lineHeight: productNameZone?.lineHeight,
                    textTransform:
                      productNameZone?.textTransform as React.CSSProperties['textTransform'],
                  }}
                  itemProp="name"
                >
                  {name}
                </p>
              </Link>
            )}
            {priceVisible && (
              <div
                className={`flex items-baseline gap-2 ${styles.productCardBody ? 'justify-center' : ''}`}
              >
                <span
                  itemProp="offers"
                  itemScope
                  itemType="https://schema.org/Offer"
                  className="contents"
                >
                  <meta itemProp="priceCurrency" content={currency} />
                  <meta itemProp="price" content={String(pricing.displayPrice / 1000)} />
                  <span
                    data-zone="productPrice"
                    className={`font-bold tabular-nums ${textSizes.price} ${styles.productCardPrice}`}
                    style={{
                      fontFamily: productPriceZone?.fontFamily,
                      fontSize: responsiveFontSize(productPriceZone?.fontSize),
                      fontWeight: productPriceZone?.fontWeight,
                      color: productPriceZone?.color,
                      letterSpacing: productPriceZone?.letterSpacing,
                      lineHeight: productPriceZone?.lineHeight,
                      textTransform:
                        productPriceZone?.textTransform as React.CSSProperties['textTransform'],
                    }}
                  >
                    {pricing.mode === 'fromMin' ? `${isRtl ? 'من ' : 'From '}` : ''}
                    {localize((pricing.displayPrice / 1000).toFixed(3))} {currency}
                  </span>
                </span>
                {pricing.displayCompare && (
                  <span className="text-sm text-muted-foreground line-through">
                    {localize((pricing.displayCompare / 1000).toFixed(3))}
                  </span>
                )}
              </div>
            )}
            {priceVisible && <TaxInclusiveLabel className="block text-xs text-muted-foreground" />}
          </>
        )}

        {/* Dual CTA pattern (per docs/superpowers/plans/2026-05-16-mobile-ui-
            ship.md): products WITH variants can't be added to cart inline —
            customer must pick a size/weight on the detail page, so the
            button is "View" linking to the detail page. Products WITHOUT
            variants add to cart directly. Matches pecannbee target IMG_7994
            where two adjacent cards show different button texts based on
            inventory state. */}
        {(product.variants && product.variants.length > 0) || viewOnly ? (
          <Link
            href={href}
            prefetch={false}
            className={cn(
              `mt-auto inline-flex w-full items-center justify-center gap-2 ${textSizes.btn} ${textSizes.cta} ${styles.productCardCta}`,
              ctaExtraCls
            )}
            data-cta="button"
            style={{
              fontFamily: productCtaZone?.fontFamily,
              fontSize: responsiveFontSize(productCtaZone?.fontSize),
              fontWeight: productCtaZone?.fontWeight,
              color:
                resolvedText ??
                guardedCtaColor(productCtaZone?.color, styles.productCardCta, store.theme),
              letterSpacing: productCtaZone?.letterSpacing,
              lineHeight: productCtaZone?.lineHeight,
              textTransform: productCtaZone?.textTransform as React.CSSProperties['textTransform'],
              ...(resolvedBg ? { backgroundColor: resolvedBg } : {}),
            }}
          >
            {(isRtl ? resolvedCtaLabelTextAr : resolvedCtaLabelTextEn) ?? (isRtl ? 'عرض' : 'View')}
          </Link>
        ) : (
          <button
            type="button"
            disabled={!orderable || isAdding}
            onClick={handleAdd}
            data-cta="button"
            className={cn(
              `mt-auto inline-flex w-full items-center justify-center gap-2 min-h-[44px] ${styles.productCardCta} disabled:cursor-not-allowed disabled:opacity-60`,
              ctaExtraCls
            )}
            style={{
              fontFamily: productCtaZone?.fontFamily,
              fontSize: responsiveFontSize(productCtaZone?.fontSize),
              fontWeight: productCtaZone?.fontWeight,
              color:
                resolvedText ??
                guardedCtaColor(productCtaZone?.color, styles.productCardCta, store.theme),
              letterSpacing: productCtaZone?.letterSpacing,
              lineHeight: productCtaZone?.lineHeight,
              textTransform: productCtaZone?.textTransform as React.CSSProperties['textTransform'],
              ...(resolvedBg ? { backgroundColor: resolvedBg } : {}),
            }}
          >
            {!orderable ? (
              isRtl ? (
                (resolvedCtaLabelTextAr ?? 'نفدت الكمية')
              ) : (
                (resolvedCtaLabelTextEn ?? 'Out Of Stock')
              )
            ) : (
              <>
                {isAdding ? (
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                ) : (
                  <CartIcon className="h-4 w-4" aria-hidden={true} />
                )}
                {(isRtl ? resolvedCtaLabelTextAr : resolvedCtaLabelTextEn) ??
                  (isRtl ? 'إضافة للسلة' : 'Add to Cart')}
              </>
            )}
          </button>
        )}
      </div>
    </article>
  );
}

export const PecannbeeProductCard = memo(PecannbeeProductCardImpl, productCardPropsEqual);
