'use client';

import { memo, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import type { ProductCardProps } from '../types';
import type { TemplateId, ProductCardSize } from '@force/shared';
import { getProductCardTextSizes } from '@force/shared';
import { useLanguage } from '../../contexts/LanguageContext';
import { getPackStyles } from './pack-styles';
import { productCardPropsEqual } from './product-card-memo';
import { TaxInclusiveLabel } from './tax-inclusive-label';
import { OutOfStockRibbon, isProductNew } from './ProductCardCta';
import { BrandPill } from './BrandPill';

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
}: PecannbeeProductCardProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const styles = getPackStyles(pack);
  const textSizes = getProductCardTextSizes(cardSize);
  const [isWishlisted, setIsWishlisted] = useState(false);
  const [isAdding, setIsAdding] = useState(false);

  const inStock = product.inStock !== false;
  const onSale = !!(product.compareAtPrice && product.compareAtPrice > product.price);
  const discountPct = onSale
    ? Math.round((1 - product.price / (product.compareAtPrice ?? product.price)) * 100)
    : 0;

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
    if (!inStock || !onAddToCart) return;
    setIsAdding(true);
    try {
      await onAddToCart(product.id);
    } finally {
      setIsAdding(false);
    }
  };

  const showNewBadge = inStock && isProductNew(product);

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
      className={`group flex flex-col overflow-hidden w-full md:max-w-[200px] mx-auto transition-all duration-500 ease-out md:hover:scale-[1.02] md:hover:shadow-[0_20px_40px_-20px_hsl(var(--foreground)/0.18)] ${styles.card}`}
      dir={isRtl ? 'rtl' : 'ltr'}
      itemScope
      itemType="https://schema.org/Product"
      aria-labelledby={`prod-${product.id}-name`}
    >
      <Link
        href={href}
        prefetch={false}
        className="group/img block focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        {/* Image: mobile 1:1 (square reads cleaner in tight 2-up grids),
            desktop 3:4 portrait per design.md canonical product image
            size 600×800. PecannbeeProductCard is the PLP / search /
            category-listing card; per-store cardAspect on the homepage
            carousels lives on theme-specific ProductCards instead. */}
        <div className="relative aspect-square sm:aspect-[3/4] overflow-hidden bg-muted">
          {img ? (
            <>
              <Image
                src={img}
                alt={product.images?.[0]?.alt ?? name}
                fill
                sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 200px"
                className={`object-cover transition-opacity duration-500 ${
                  product.images?.[1]?.url ? 'group-hover/img:opacity-0' : ''
                }`}
              />
              {product.images?.[1]?.url && (
                <Image
                  src={product.images[1].url}
                  alt={product.images[1].alt ?? name}
                  fill
                  sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 200px"
                  loading="lazy"
                  className="absolute inset-0 object-cover opacity-0 transition-opacity duration-500 group-hover/img:opacity-100"
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

          {/* Wishlist heart — top-START (RTL right, LTR left) per spec § 4.3 */}
          <button
            type="button"
            onClick={handleWishlist}
            aria-label={isRtl ? 'إضافة للمفضلة' : 'Add to wishlist'}
            aria-pressed={isWishlisted}
            className={`absolute top-3 start-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/95 backdrop-blur-sm shadow-[0_8px_20px_-8px_hsl(var(--foreground)/0.30)] transition-all duration-300 ease-out hover:scale-[1.05] hover:bg-white cursor-pointer ${
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

          {/* Sprint 2 (2026-05-17): replaced the inline OOS pill with the
              shared OutOfStockRibbon component — proper diagonal corner
              ribbon at -45°, consumed by all 5 themes already. NEW
              orange badge added below it (top-START) when product is
              flagged new OR was created in the last 14 days. */}
          <OutOfStockRibbon inStock={inStock} isRtl={isRtl} />
          {showNewBadge && (
            <span
              className="absolute top-3 start-3 z-10 rounded-full bg-[hsl(var(--primary))] px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-[hsl(var(--primary-foreground))] shadow-[0_6px_14px_-6px_hsl(var(--primary)/0.5)]"
              aria-label={isRtl ? 'منتج جديد' : 'New product'}
            >
              {isRtl ? 'جديد' : 'NEW'}
            </span>
          )}
          {/* Bucket C5: brand pill — hidden when OOS ribbon or NEW
              badge already occupies the top-START corner. */}
          <BrandPill hidden={!inStock || showNewBadge} />
          {/* Sale chip top-END when in stock */}
          {inStock && onSale && (
            <span className="absolute top-3 end-3 z-10 rounded-full bg-foreground/90 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-background shadow-[0_8px_20px_-8px_hsl(var(--foreground)/0.35)]">
              -{discountPct}%
            </span>
          )}
        </div>
      </Link>

      {/* Card chrome tightened 2026-05-16 per ahmad 'products are too big':
          p-5/p-6 → p-3/p-4 (~10px smaller padding × 4 sides), gap-3 → gap-2,
          and dropped the min-h-[3em] name reservation so the card shrinks
          to whatever the actual content needs. Net effect: ~20-30px shorter
          per card on mobile, denser grid feel matches the pecannbee target. */}
      <div className={`flex flex-1 flex-col gap-2 p-3 sm:p-4 ${styles.productCardBody ?? ''}`}>
        <Link href={href} prefetch={false} className="focus:outline-none focus-visible:underline">
          <p
            id={`prod-${product.id}-name`}
            className={`line-clamp-2 ${textSizes.name} ${styles.productCardName}`}
            style={{ textWrap: 'balance' }}
            itemProp="name"
          >
            {name}
          </p>
        </Link>
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
            <meta itemProp="price" content={String(product.price / 1000)} />
            <span className={`${textSizes.price} ${styles.productCardPrice}`}>
              {(product.price / 1000).toFixed(3)} {currency}
            </span>
          </span>
          {onSale && product.compareAtPrice && (
            <span className="text-sm text-muted-foreground line-through">
              {(product.compareAtPrice / 1000).toFixed(3)}
            </span>
          )}
        </div>
        <TaxInclusiveLabel className="block text-xs text-muted-foreground" />

        {/* Dual CTA pattern (per docs/superpowers/plans/2026-05-16-mobile-ui-
            ship.md): products WITH variants can't be added to cart inline —
            customer must pick a size/weight on the detail page, so the
            button is "View" linking to the detail page. Products WITHOUT
            variants add to cart directly. Matches pecannbee target IMG_7994
            where two adjacent cards show different button texts based on
            inventory state. */}
        {product.variants && product.variants.length > 0 ? (
          <Link
            href={href}
            prefetch={false}
            className={`mt-auto inline-flex w-full items-center justify-center gap-2 min-h-[44px] ${styles.productCardCta}`}
          >
            {isRtl ? 'عرض' : 'View'}
          </Link>
        ) : (
          <button
            type="button"
            disabled={!inStock || isAdding}
            onClick={handleAdd}
            className={`mt-auto inline-flex w-full items-center justify-center gap-2 min-h-[44px] ${styles.productCardCta} disabled:cursor-not-allowed disabled:opacity-60`}
          >
            {!inStock ? (
              isRtl ? (
                'نفدت الكمية'
              ) : (
                'Out Of Stock'
              )
            ) : (
              <>
                {isAdding ? (
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                ) : (
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z"
                    />
                  </svg>
                )}
                {isRtl ? 'إضافة للسلة' : 'Add to Cart'}
              </>
            )}
          </button>
        )}
      </div>
    </article>
  );
}

export const PecannbeeProductCard = memo(PecannbeeProductCardImpl, productCardPropsEqual);
