'use client';

import Link from 'next/link';
import { useLocalePrice } from '../../hooks/useLocalePrice';
import Image from 'next/image';
import type { Product } from '@/lib/api';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { getProductPricing, getDiscountBadgeText } from '@/lib/product-pricing';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { resolveColor } from '@force/shared';
import { cn, CartIcon } from '@force/ui';
import { OosImageDim, OutOfStockRibbon } from '../../templates/shared/ProductCardCta';
import { ctaShapeClass, ctaSizeClass } from '../../templates/shared/card-size';
import type { CtaShape, CtaSize } from '../../templates/shared/card-size';
import {
  getDiscountBadgeColor,
  getDiscountBadgePosition,
} from '../../templates/shared/discount-badge';

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
  const priceVisible = showCardPrice !== false;
  // Localized name for alt text + heading. Falls through to English when
  // the merchant hasn't supplied an Arabic translation.
  const displayName = isRtl && product.nameAr ? product.nameAr : product.name;
  const displayCategory = isRtl
    ? (product.categories?.[0]?.category?.nameAr ?? product.categories?.[0]?.category?.name)
    : product.categories?.[0]?.category?.name;
  // Variant-aware pricing. Listing cards use the `card` surface so
  // multi-variant products render "From <min>" instead of the parent's
  // (often stale) standalone price.
  const pricing = getProductPricing(product, undefined, 'card');
  // BUG 1 fix: use helper for correct KWD/pct badge text.
  const discountBadgeText = getDiscountBadgeText(product, isRtl);
  // Task 13: orderable = truly in-stock OR backorder allowed. Derived from
  // inventory because ProductListItem uses a richer inventory check (undefined
  // means variant-managed stock → treat as orderable). OOS + backorder = orderable.
  const orderable =
    product.inventory === undefined || product.inventory > 0 || product.acceptsBackorder === true;

  // Task 3 B3/B4: read CTA + OOS defaults from productCardDefaults.
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
  const nameCase = defaults?.productNameCase;
  // ctaMode: 'viewOnly' forces the View link for no-variant in-stock products too.
  const viewOnly = defaults?.ctaMode === 'viewOnly';
  // Discount/sale badge — merchant-configurable corner + color. Unset
  // position defaults to bottom-left (physical, not RTL-mirrored).
  const discountBadgePositionCls = getDiscountBadgePosition(
    defaults?.discountBadge?.position,
    isRtl
  );
  const discountBadgeColor = getDiscountBadgeColor(defaults?.discountBadge?.color, store.theme);

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
      className="flex gap-4 rounded-2xl border border-border bg-card p-4 transition-all hover:border-primary/30 hover:shadow-lg"
    >
      {/* Image */}
      <div className="relative h-32 w-32 flex-shrink-0 overflow-hidden rounded-xl bg-gradient-to-br from-primary/5 to-primary/10">
        {/* Sale badge — BUG 1 fix: show KWD or pct text via helper.
            BUG 2 fix: no inStock gate. Corner + color are merchant-
            configurable via productCardDefaults.discountBadge (default
            bottom-left, physical — never mirrors with RTL). */}
        {(pricing.displayCompare || pricing.hasVariantDiscount) && discountBadgeText && (
          <span
            className={cn(
              'absolute z-10 rounded-full px-2 py-0.5 text-xs font-bold uppercase text-white',
              discountBadgePositionCls
            )}
            style={{ backgroundColor: discountBadgeColor }}
          >
            {discountBadgeText}
          </span>
        )}
        {/* Task 3 B4: OOS badge on list view — sits inside the image container. */}
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
          <div className="flex h-full items-center justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
              <svg
                className="h-8 w-8 text-primary"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1}
                  d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                />
              </svg>
            </div>
          </div>
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
            className={`mt-1 text-lg font-semibold text-foreground${nameCase === 'uppercase' ? ' uppercase' : ''}`}
            data-zone="productName"
          >
            {displayName}
          </h3>
        </div>
        <div className="flex items-center justify-between">
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
              className={`flex h-10 w-10 items-center justify-center rounded-xl border transition-colors ${
                isInCompare
                  ? 'border-primary bg-primary text-white'
                  : 'border-border bg-background text-muted-foreground hover:border-primary hover:text-primary'
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
            {viewOnly ? (
              <span
                className={cn(
                  'flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-white pointer-events-none',
                  ctaExtraCls
                )}
                style={{
                  ...(resolvedBg ? { backgroundColor: resolvedBg } : {}),
                  ...(resolvedText ? { color: resolvedText } : {}),
                }}
              >
                {ctaViewLabel}
              </span>
            ) : (
              <button
                className={cn(
                  'flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary/90',
                  ctaExtraCls
                )}
                onClick={e => onAddToCart(product, e)}
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
