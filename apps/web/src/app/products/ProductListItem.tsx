'use client';

import { useEffect, useId, useRef } from 'react';
import { CardStepper } from '../../templates/shared/CardStepper';
import { useCardStepperLine } from '../../templates/shared/card-stepper-context';
import { requestStepperFocus, takeStepperFocus } from '../../templates/shared/card-stepper-focus';
import { pickLocalizedName } from '../../templates/shared/display-helpers';
import { canBuyNow } from '@/lib/can-buy-now';
import Link from '../../components/StoreLink';
import { resolveProductCardCtaOosDefaults } from '../../templates/shared/product-card-defaults';
import { useLocalePrice } from '../../hooks/useLocalePrice';
import { useStoreNumerals } from '../../hooks/useNumerals';
import Image from 'next/image';
import type { Product } from '@/lib/api';
import { SwatchDots } from '../../components/commerce/SwatchDots';
import { FactChips } from '../../components/commerce/FactChips';
import { Model3dChip } from '../../components/commerce/Model3dChip';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { getProductPricing, getDiscountBadgeText } from '@/lib/product-pricing';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { getLook, resolveColor } from '@ebda/shared';
import { cn, CartIcon } from '@ebda/ui';
import { OosImageDim, OutOfStockRibbon } from '../../templates/shared/ProductCardCta';
import { lookCardCta, lookCtaVisible, QUIET_CARD_CTA_CLS } from '../../templates/shared/look-card';
import { needsOptions } from '../../templates/adapters';
import { ctaShapeClass, ctaSizeClass } from '../../templates/shared/card-size';
import { getDiscountBadgeColor } from '../../templates/shared/discount-badge';
import {
  getCustomBadgeColor,
  getCustomBadgeTextColor,
  resolveCardBadges,
} from '../../templates/shared/custom-badge';
import { MissingImage } from '../../templates/shared/MissingImage';

interface ProductListItemProps {
  product: Product;
  isInCompare: boolean;
  onToggleCompare: (product: Product, e: React.MouseEvent) => void;
  onAddToCart: (product: Product, e: React.MouseEvent) => void;
  /** Effective price visibility (already composed from productCardDefaults.showCardPrice
   *  + theme.showPriceOnCards by the parent). When false, the price is hidden — the
   *  list view is a product-card render path and must honor the toggle like the grid. */
  showCardPrice?: boolean;
}

export function ProductListItem({
  product,
  isInCompare,
  onToggleCompare,
  onAddToCart,
  showCardPrice,
}: ProductListItemProps) {
  const { t, isRtl } = useLanguage();
  const { store, layout } = useStore();
  const storeUrl = useStoreUrl();
  const formatPrice = useLocalePrice();
  const numerals = useStoreNumerals();
  const priceVisible = showCardPrice !== false;
  // Ruling B4-4 on the list view too: a dish already in the cart shows - qty + here, never a second
  // "Add" that would silently add another unit (null off the Lamma looks).
  const stepperLine = useCardStepperLine(product.id, { hasVariants: needsOptions(product) });
  const instance = useId();
  const addRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!stepperLine && takeStepperFocus(instance, 'add')) addRef.current?.focus();
  }, [stepperLine, instance]);
  // Localized name for alt text + heading. Falls through to English when
  // the merchant hasn't supplied an Arabic translation.
  const displayName = pickLocalizedName(product, isRtl) ?? product.name;
  const displayCategory = pickLocalizedName(product.categories?.[0]?.category, isRtl);
  // Variant-aware pricing. Listing cards use the `card` surface so
  // multi-variant products render "From <min>" instead of the parent's
  // (often stale) standalone price.
  const pricing = getProductPricing(product, undefined, 'card');
  // BUG 1 fix: use helper for correct EGP/pct badge text.
  const discountBadgeText = getDiscountBadgeText(product, isRtl, undefined, undefined, numerals);
  // Task 13: orderable = truly in-stock OR backorder allowed. OOS + backorder =
  // orderable. Stock reads the server's variant-aware `inStock` first (the
  // shared card rule, lib/can-buy-now.ts canBuyNow).
  const orderable = canBuyNow(product);
  // C-01: a sized product is chosen on its PDP. This row used to render the
  // add button for every product, so a list-view tap added a sizeless line (and
  // a sold-out product's tap failed with an error toast).
  const hasVariants = needsOptions(product);

  // Task 3 B3/B4: read CTA + OOS defaults from productCardDefaults.
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
  // Discount/sale + custom badge — same single-owner mutex as the grid
  // cards. `orderable` here is the list view's richer inventory-based signal
  // computed above, not `product.inStock`. No collision inputs needed here:
  // the list thumbnail has no heart/compare/quick-add overlay (its compare
  // button and CTA render inline in the content row, not over the image).
  const discountBadgeColor = getDiscountBadgeColor(defaults?.discountBadge?.color, store.theme);
  const customBadgeColor = getCustomBadgeColor(defaults?.customBadge?.color, store.theme);
  const customBadgeTextColor = getCustomBadgeTextColor(defaults?.customBadge?.color, store.theme);
  const {
    customBadgeText,
    discountBadgeAllowed,
    customBadgePositionCls,
    discountBadgePositionCls,
    discountTopCorner,
  } = resolveCardBadges({
    discountVisible: Boolean(discountBadgeText),
    product,
    isRtl,
    orderable,
    customPosition: defaults?.customBadge?.position,
    discountPosition: defaults?.discountBadge?.position,
    // Issue #1998 — top-corner sale badge unless the store keeps the legacy
    // bottom-left corner (per-store StoreTheme DATA, never a slug check).
    saleBadgeTopCorner: store.theme?.saleBadgeLegacyCorner !== true,
  });

  // CTA shape + size extra classes.
  const ctaExtraCls = [ctaShapeClass(resolvedCtaShape), ctaSizeClass(resolvedCtaSize)]
    .filter(Boolean)
    .join(' ');
  const resolvedBg =
    resolvedCtaColor && store.theme ? resolveColor(resolvedCtaColor, store.theme) : undefined;
  const resolvedText =
    resolvedCtaTextColor && store.theme
      ? resolveColor(resolvedCtaTextColor, store.theme)
      : undefined;
  const ctaAddLabel =
    (isRtl ? resolvedCtaLabelTextAr : resolvedCtaLabelTextEn) ??
    t('Add to Cart', translations['Add to Cart']);
  const ctaViewLabel =
    (isRtl ? resolvedCtaLabelTextAr : resolvedCtaLabelTextEn) ?? (isRtl ? 'عرض' : 'View');

  return (
    <Link
      href={storeUrl(`/products/${product.slug}`)}
      /* boundary: card-frame (decoration, not a control) */
      className="flex gap-4 rounded-2xl border border-border bg-card p-4 transition hover:border-primary/30 hover:shadow-lg"
    >
      {/* Image */}
      <div className="relative h-32 w-32 flex-shrink-0 overflow-hidden rounded-xl bg-gradient-to-br from-primary/5 to-primary/10">
        {/* Sale badge — BUG 1 fix: show EGP or pct text via helper.
            BUG 2 fix: no inStock gate. Corner + color are merchant-
            configurable via productCardDefaults.discountBadge (physical;
            unset = top corner, or bottom-left when theme.saleBadgeLegacyCorner, #1998). */}
        {(pricing.displayCompare || pricing.hasVariantDiscount) &&
          discountBadgeAllowed &&
          discountBadgeText && (
            <span
              className={cn(
                'pointer-events-none absolute z-10 rounded-full px-2 py-0.5 text-xs font-bold uppercase text-white',
                discountBadgePositionCls
              )}
              style={{ backgroundColor: discountBadgeColor }}
            >
              {discountBadgeText}
            </span>
          )}
        {/* Custom badge — merchant's own words (Product.badgeLabel/-Ar).
            Same chip geometry as the sale chip above; only corner + color
            differ. The list thumbnail is small, so the chip inherits the
            list view's tighter padding rather than the grid's. */}
        {customBadgeText && (
          <span
            className={cn(
              'pointer-events-none absolute z-10 rounded-full px-2 py-0.5 text-xs font-bold uppercase text-white',
              customBadgePositionCls
            )}
            style={{ backgroundColor: customBadgeColor, color: customBadgeTextColor }}
          >
            {customBadgeText}
          </span>
        )}
        {/* Task 3 B4: OOS badge on list view — sits inside the image container. */}
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
          topStartReserved={discountTopCorner === 'start'}
          topEndReserved={discountTopCorner === 'end'}
        />
        {/* Image overlay tint when out-of-stock. z-[5] sits under the OOS
            badge (z-10) and above the product image. */}
        <OosImageDim orderable={orderable} oosDimColor={resolvedOosDimColor} theme={store.theme} />
        {product.images?.[0]?.url ? (
          <Image
            src={product.images[0].url}
            alt={product.images[0].alt || displayName}
            width={128}
            height={128}
            className="h-full w-full object-cover"
            sizes="128px"
          />
        ) : (
          <MissingImage label={displayName} size="sm" />
        )}
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col justify-between">
        <div>
          {product.categories?.[0] && (
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {displayCategory}
            </p>
          )}
          <h3
            className={`mt-1 text-lg font-semibold text-foreground [overflow-wrap:anywhere]${nameCase === 'uppercase' ? ' uppercase' : ''}`}
            data-zone="productName"
          >
            {displayName}
          </h3>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-1.5">
            {priceVisible ? (
              <div className="flex items-center gap-2">
                {pricing.mode === 'fromMin' && (
                  <span className="text-xs text-muted-foreground">{t('From', 'ابتداءً من')}</span>
                )}
                <span
                  className="text-xl font-bold text-primary tabular-nums"
                  data-zone="productPrice"
                >
                  {formatPrice(pricing.displayPrice)}
                </span>
                {pricing.displayCompare && pricing.displayCompare > pricing.displayPrice && (
                  <span className="text-sm text-muted-foreground line-through">
                    {formatPrice(pricing.displayCompare)}
                  </span>
                )}
              </div>
            ) : (
              <span />
            )}
            <SwatchDots product={product} max={5} />
            <FactChips product={product} className="mt-1" />
            <Model3dChip product={product} className="mt-1" />
          </div>
          <div className="flex items-center gap-2">
            {/* Compare button for list view */}
            <button
              aria-label={
                isInCompare
                  ? t('Remove from compare', 'إزالة من المقارنة')
                  : t('Add to compare', 'إضافة إلى المقارنة')
              }
              title={
                isInCompare
                  ? t('Remove from compare', 'إزالة من المقارنة')
                  : t('Add to compare', 'إضافة إلى المقارنة')
              }
              className={`flex h-11 w-11 items-center justify-center rounded-xl border transition-colors ${
                isInCompare
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-input bg-background text-muted-foreground hover:border-primary hover:text-primary'
              }`}
              onClick={e => onToggleCompare(product, e)}
            >
              <svg
                className="h-4 w-4"
                fill={isInCompare ? 'currentColor' : 'none'}
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={isInCompare ? 0 : 1.75}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                />
              </svg>
            </button>

            {/* Task 3 B3: CTA shape/size/color/label customization + OOS dim.
                When ctaMode==='viewOnly', show a View label instead of Add to cart.
                The entire ProductListItem is wrapped in a Link so no nested anchor
                is needed — a span with the same visual chrome suffices. */}
            {!lookCtaVisible(lookCta, {
              hasVariants: viewOnly || hasVariants,
              orderable,
            }) ? null : viewOnly || hasVariants ? (
              <span
                className={cn(
                  'flex h-11 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground pointer-events-none',
                  ctaExtraCls
                )}
                style={{
                  ...(resolvedBg ? { backgroundColor: resolvedBg } : {}),
                  ...(resolvedText ? { color: resolvedText } : {}),
                }}
              >
                {ctaViewLabel}
              </span>
            ) : !orderable ? (
              <button
                type="button"
                disabled
                className={cn(
                  'flex h-11 items-center gap-2 rounded-xl bg-muted px-4 text-sm font-medium text-muted-foreground cursor-not-allowed',
                  ctaExtraCls
                )}
                onClick={e => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                {t('Out of Stock', translations['Out of Stock'])}
              </button>
            ) : stepperLine ? (
              <CardStepper line={stepperLine} instance={instance} className="w-auto min-w-[9rem]" />
            ) : (
              <button
                ref={addRef}
                className={cn(
                  lookCta === 'quiet'
                    ? `flex h-11 items-center gap-2 ${QUIET_CARD_CTA_CLS}`
                    : 'flex h-11 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90',
                  ctaExtraCls
                )}
                onClick={e => {
                  requestStepperFocus(instance, 'step');
                  onAddToCart(product, e);
                }}
                style={{
                  ...(resolvedBg ? { backgroundColor: resolvedBg } : {}),
                  ...(resolvedText ? { color: resolvedText } : {}),
                }}
              >
                <CartIcon className="h-4 w-4" />
                {ctaAddLabel}
              </button>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}
