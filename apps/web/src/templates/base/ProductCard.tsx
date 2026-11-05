'use client';

import { memo, useId } from 'react';
import { canBuyNow } from '@/lib/can-buy-now';
import { resolveProductCardCtaOosDefaults } from '../shared/product-card-defaults';
import {
  lookCardCta,
  lookCtaVisible,
  lookChip,
  LOOK_CHIP_CLS,
  LOOK_CHIP_STYLE,
  LOOK_NEW_CHIP_STYLE,
} from '../shared/look-card';
import Link from '../../components/StoreLink';
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
  getLook,
} from '@ebda/shared';
import { CompareButton, RemoveFromWishlistButton, cardLinkLabel } from '../shared/card-actions';
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
import { useRenderNow } from '../../contexts/RenderClockContext';
import { MissingImage } from '../shared/MissingImage';
import { CARD_GRID_SIZES } from '../../lib/image-sizes';

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
  // One id per card INSTANCE: a product can render in a grid and a carousel on the same page.
  const nameId = `prod-${useId()}-name`;
  const { isRtl: ctxIsRtl, t } = useLanguage();
  const { store, layout } = useStore();
  const renderNow = useRenderNow();
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
  const orderable = canBuyNow(product);
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
  // Look card action (W2b, L-01): undefined on a store with no look.
  const lookCta = lookCardCta(store.theme, layout);
  const chip = lookChip(store.theme);
  // Discount/sale badge — minimal's badge is inline text below the price
  // (no corner overlay by design, "minimal pack stays chrome-free"), so
  // only the merchant-configurable COLOR applies here; the position field
  // is a no-op for this theme. The label is TEXT here, so an unset color
  // falls back to the store's destructive ink (>= 4.5:1 on its page, K-01).
  const discountBadgeColor = getDiscountBadgeColor(
    defaults?.discountBadge?.color,
    store.theme,
    'text'
  );
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
    newOrBrandBadgeReserved: Boolean(
      product.inStock !== false && isProductNew(product, renderNow, store.theme)
    ),
    bottomOverlay: 'both',
  });

  return (
    <article
      itemScope
      itemType="https://schema.org/Product"
      aria-labelledby={nameId}
      // IA-05 (W4): a look store's card fills its grid column; no look keeps the centred cap.
      className={`w-full ${getLook(store.look) ? '' : `mx-auto ${productSizeClass(cardSize)}`} ${frameCls}`
        .replace(/\s+/g, ' ')
        .trim()}
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
          className={`relative overflow-hidden bg-muted/30 mb-3 ${imgRadiusCls || (getLook(store.look) ? 'rounded-[var(--radius)]' : shape.radius)} ${imgAspectCls || aspectOverride || lookImageAspectClass(store.look) || 'aspect-square sm:aspect-[3/4]'}`}
        >
          {/* Platform-level OOS ribbon — minimal pack stays chrome-free
              elsewhere, but the OOS state needs unambiguous communication
              regardless of pack philosophy (2026-05-16).
              Task 3 B4: OOS badge customization via productCardDefaults. */}
          <OutOfStockRibbon
            flat={!!getLook(store.look)}
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
          {product.inStock !== false && isProductNew(product, renderNow, store.theme) && (
            <span
              className={
                getLook(store.look)
                  ? cn(LOOK_CHIP_CLS, 'top-2 start-2')
                  : 'absolute top-2 start-2 z-10 px-2 py-0.5 text-xs font-medium uppercase tracking-[0.18em] text-[hsl(var(--primary))] bg-background'
              }
              // VT-b: neutral on every look; the accent is the sale chip's alone.
              style={getLook(store.look) ? LOOK_NEW_CHIP_STYLE : undefined}
              aria-hidden="true"
              data-badge="new"
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
                chip
                  ? LOOK_CHIP_CLS
                  : 'pointer-events-none absolute z-10 px-2 py-0.5 text-xs font-medium uppercase tracking-[0.18em] text-white',
                customBadgePositionCls
              )}
              style={
                chip && !defaults?.customBadge?.color
                  ? LOOK_CHIP_STYLE
                  : { backgroundColor: customBadgeColor, color: customBadgeTextColor }
              }
              aria-hidden="true"
            >
              {customBadgeText}
            </span>
          )}
          {onToggleCompare && (
            <CompareButton
              productId={product.id}
              productName={isRtl && product.nameAr ? product.nameAr : product.name}
              isInCompare={isInCompare}
              onToggle={onToggleCompare}
              isRtl={isRtl}
            />
          )}
          {onRemoveFromWishlist && (
            <RemoveFromWishlistButton
              productId={product.id}
              productName={isRtl && product.nameAr ? product.nameAr : product.name}
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
                sizes={CARD_GRID_SIZES}
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
                  sizes={CARD_GRID_SIZES}
                  loading="lazy"
                />
              )}
            </>
          ) : (
            <MissingImage label={isRtl && product.nameAr ? product.nameAr : product.name} />
          )}

          {/* Desktop hover-only quick-add — minimal stays chrome-free by
              default (no button visible). On lg+ pointer devices the
              CTA fades in over the image bottom on hover. Mobile (no
              hover) shows nothing — customers tap the card to land on
              PDP. Compromise per Ahmad 2026-05-16: 'desktop converts
              faster, mobile stays pure'. Text-only underlined link
              vocabulary matches minimal's font-light tracking-[0.2em]
              language. */}
          {lookCtaVisible(lookCta, {
            hasVariants: (!!product.variants && product.variants.length > 0) || viewOnly,
            orderable,
          }) && (
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
                  addToCart: isRtl ? 'أضف للسلة' : 'Add to cart',
                  addedToCart: isRtl ? 'اتضاف' : 'Added',
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
          )}
        </div>

        {/* Text — PC-1: name/price sizes from textSizes; PC-2: pad from textSizes.pad. */}
        {showLabel !== false && (nameVisible || priceVisible) && (
          <div className={`flex flex-col gap-2 ${textSizes.pad} text-start`}>
            {nameVisible && (
              <h3
                id={nameId}
                data-zone="productName"
                className={`${textSizes.name} tracking-normal sm:tracking-[0.18em] ${nameCase === 'uppercase' ? 'uppercase' : ''} font-light text-muted-foreground group-hover:text-foreground transition-colors duration-500 ease-out leading-snug [overflow-wrap:anywhere] line-clamp-2 min-h-[2.5em]`}
                itemProp="name"
              >
                {isRtl && product.nameAr ? product.nameAr : product.name}
              </h3>
            )}
            {/* P2-14: the chips are aria-hidden; their words follow the name. */}
            {(() => {
              const after = cardLinkLabel('', [
                product.inStock !== false &&
                  isProductNew(product, renderNow, store.theme) &&
                  t('New', 'جديد'),
                customBadgeText,
              ]);
              return after ? <span className="sr-only">{after}</span> : null;
            })()}
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
              <TaxInclusiveLabel className="block text-xs tracking-wide font-normal text-muted-foreground" />
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
