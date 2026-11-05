'use client';

/**
 * Dahab product card. One card for every Dahab surface (homepage grids and
 * carousels, the collection page, related products): the platform card
 * (templates/shared) hands over to it when `pack === 'dahab'`, so the platform's card call sites
 * stay the only call sites.
 *
 *   ┌──────────────────────┐
 *   │ جديد                 │  badges top-start (stock state outranks promotion)
 *   │   4:5 photograph     │  second photo cross-fades in on hover (fine pointers)
 *   │                      │
 *   │      [ أضيفي للسلة ]  │  quick add slides up on hover; always visible on touch
 *   └──────────────────────┘
 *   خاتم سوليتير ذهب ١٨
 *   4,500 ج.م   5,200 ج.م
 *
 * Commerce rules kept from the platform card: variant products show "From"
 * and send the shopper to the product page instead of adding a guessed
 * variant; out-of-stock products are dimmed and not addable unless they
 * accept backorders; the merchant's own badge text and the price-visibility
 * master toggle are honoured.
 */
import { useEffect, useState } from 'react';
import { canBuyNow } from '@/lib/can-buy-now';
import Image from 'next/image';
import Link from '../../components/StoreLink';
import type { ProductCardProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { useStore } from '../../contexts/StoreContext';
import { lookImageAspectClass } from '../shared/card-size';
import { useNumerals } from '../../hooks/useNumerals';
import { useLocalePrice } from '../../hooks/useLocalePrice';
import { getProductPricing, getDiscountBadgeText, isOnSale } from '../../lib/product-pricing';
import { isProductNew } from '../shared/ProductCardCta';
import { getCustomBadgeText } from '../shared/custom-badge';
import { cx, BagIcon } from './ui';
import { SwatchDots } from '../../components/commerce/SwatchDots';
import { FactChips } from '../../components/commerce/FactChips';
import { useRenderNow } from '../../contexts/RenderClockContext';
import { MissingImage } from '../shared/MissingImage';
import { CARD_GRID_SIZES } from '../../lib/image-sizes';

export interface DahabProductCardProps extends ProductCardProps {
  /** `sizes` hint for the image (grid density decides it). */
  imageSizes?: string;
}

export default function DahabProductCard({
  product,
  isRtl: isRtlProp,
  onAddToCart,
  urlPrefix = '',
  priority,
  showCardName,
  showCardPrice,
  showLabel,
  showHover,
  imageSizes = CARD_GRID_SIZES,
}: DahabProductCardProps) {
  const { isRtl: ctxIsRtl, t } = useLanguage();
  const { store } = useStore();
  const renderNow = useRenderNow();
  const { numerals } = useNumerals();
  const formatPrice = useLocalePrice();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const [isAdding, setIsAdding] = useState(false);
  // The hover photograph is only fetched where hover exists (never on phones).
  const [canHover, setCanHover] = useState(false);
  useEffect(() => {
    setCanHover(window.matchMedia('(hover: hover) and (pointer: fine)').matches);
  }, []);

  const name = (isRtl && product.nameAr ? product.nameAr : product.name) || '';
  const href = `${urlPrefix}/products/${product.slug}`;
  const primary = product.images?.[0];
  const secondary = product.images?.[1];
  const pricing = getProductPricing(product, undefined, 'card');
  const inStock = product.inStock !== false;
  const orderable = canBuyNow(product);
  const hasVariants = (product.variants?.length ?? 0) > 0;
  const priceVisible =
    showCardPrice !== false && showLabel !== false && store.theme?.showPriceOnCards !== false;
  // Show name (showLabel) gates the name and price block, as on the other skins
  const nameVisible = showCardName !== false && showLabel !== false;

  const discount =
    orderable && isOnSale(product)
      ? getDiscountBadgeText(product, isRtl, undefined, undefined, numerals)
      : null;
  const custom = orderable ? getCustomBadgeText(product, isRtl) : null;
  const isNew = inStock && isProductNew(product, renderNow, store.theme);
  const badge = !orderable
    ? t('Sold out', 'نفدت الكمية')
    : (custom ?? discount ?? (isNew ? t('New', 'جديد') : null));

  const handleAdd = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!orderable || !onAddToCart || isAdding) return;
    setIsAdding(true);
    try {
      await onAddToCart(product.id);
    } finally {
      setIsAdding(false);
    }
  };

  const ctaLabel = hasVariants
    ? t('Choose options', 'اختيار المقاس')
    : !orderable
      ? t('Sold out', 'نفدت الكمية')
      : orderable && !inStock
        ? t('Pre-order', 'طلب مسبق')
        : t('Add to bag', 'إضافة للسلة');

  return (
    <article className="group/card relative flex flex-col" data-pack-card="dahab">
      <div className="relative">
        <Link
          href={href}
          prefetch={false}
          className="relative block overflow-hidden rounded-[var(--radius)] bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          aria-label={name}
        >
          <div
            data-part="card-image"
            className={cx(
              lookImageAspectClass(store.look)
                ? `relative w-full ${lookImageAspectClass(store.look)}`
                : 'relative aspect-[4/5] w-full',
              !orderable && 'opacity-60'
            )}
          >
            {primary?.url ? (
              <Image
                src={primary.url}
                alt={primary.alt || name}
                fill
                sizes={imageSizes}
                priority={priority}
                className="object-cover transition-transform duration-[900ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-safe:group-hover/card:scale-[1.03]"
              />
            ) : (
              <MissingImage label={name} />
            )}
            {showHover !== false && canHover && secondary?.url && (
              <Image
                src={secondary.url}
                alt=""
                aria-hidden="true"
                fill
                sizes={imageSizes}
                loading="lazy"
                className="object-cover opacity-0 transition-opacity duration-500 ease-out [@media(hover:hover)]:group-hover/card:opacity-100"
              />
            )}
            {/* Inner hairline: keeps a white-background photo from bleeding
              into the page. */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-[var(--radius)] ring-1 ring-inset ring-foreground/[0.06]"
            />
          </div>
          {badge && (
            <span
              data-badge={orderable && badge === discount ? 'sale' : undefined}
              className={cx(
                'absolute start-3 top-3 rounded-[2px] px-2 py-1 text-xs font-medium leading-none',
                orderable
                  ? 'bg-background/90 text-primary'
                  : 'bg-background/90 text-muted-foreground'
              )}
            >
              {badge}
            </span>
          )}
        </Link>

        {onAddToCart && (
          <div className="pointer-events-none absolute inset-x-3 bottom-3 flex [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:transition-[opacity,transform] [@media(hover:hover)]:duration-300 [@media(hover:hover)]:translate-y-1 [@media(hover:hover)]:group-hover/card:translate-y-0 [@media(hover:hover)]:group-hover/card:opacity-100 [@media(hover:hover)]:group-focus-within/card:opacity-100">
            {hasVariants ? (
              <Link
                href={href}
                prefetch={false}
                tabIndex={-1}
                className="pointer-events-auto hidden w-full items-center justify-center rounded-[var(--radius)] bg-background py-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-primary hover:text-primary-foreground [@media(hover:hover)]:flex [@media(hover:hover)]:min-h-[44px]"
              >
                {ctaLabel}
              </Link>
            ) : (
              <button
                type="button"
                onClick={handleAdd}
                disabled={!orderable || isAdding}
                aria-label={`${ctaLabel}: ${name}`}
                className="pointer-events-auto ms-auto flex h-11 w-11 items-center justify-center gap-2 rounded-[var(--radius)] bg-background text-[13px] font-medium text-foreground transition-colors hover:bg-primary hover:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 [@media(hover:hover)]:min-h-[44px] [@media(hover:hover)]:w-full [@media(hover:hover)]:py-2.5"
              >
                <BagIcon className="h-[18px] w-[18px] [@media(hover:hover)]:hidden" />
                <span className="hidden [@media(hover:hover)]:inline">
                  {isAdding ? t('Adding…', 'بنضيف…') : ctaLabel}
                </span>
              </button>
            )}
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-1 flex-col gap-1.5">
        {nameVisible && (
          <h3 className="line-clamp-2 text-[15px] leading-snug text-foreground [overflow-wrap:anywhere]">
            <Link
              href={href}
              prefetch={false}
              tabIndex={-1}
              className="transition-colors hover:text-primary"
            >
              {name}
            </Link>
          </h3>
        )}
        {priceVisible && (
          <p className="flex flex-wrap items-baseline gap-x-2 text-[15px] tabular-nums">
            <span className="text-primary">
              {pricing.mode === 'fromMin' ? `${t('From', 'من')} ` : ''}
              {formatPrice(pricing.displayPrice)}
            </span>
            {pricing.displayCompare && pricing.displayCompare > pricing.displayPrice && (
              <span className="text-[13px] text-muted-foreground line-through">
                <span className="sr-only">{t('Was', 'كان')} </span>
                {formatPrice(pricing.displayCompare)}
              </span>
            )}
          </p>
        )}
        <SwatchDots product={product} max={5} />
        <FactChips product={product} className="mt-1" />
      </div>
    </article>
  );
}
