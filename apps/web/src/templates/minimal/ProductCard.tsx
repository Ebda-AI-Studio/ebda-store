'use client';

import { memo } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import type { ProductCardProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { useStore } from '../../contexts/StoreContext';
import { resolveColor } from '@force/shared';
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
  cardFrameStyle: _cardFrameStyle,
  cardFrameWidth: _cardFrameWidth,
  cardFrameSize: _cardFrameSize,
  cardFrameColor,
}: ProductCardProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const { store } = useStore();
  const isRtl = isRtlProp ?? ctxIsRtl;
  // Variant-aware pricing — see lib/product-pricing.ts.
  const pricing = getProductPricing(product, undefined, 'card');
  const hasSale = !!pricing.displayCompare || pricing.hasVariantDiscount;
  const handleAddToCart = async (productId: string) => {
    await onAddToCart?.(productId);
  };
  return (
    <article
      itemScope
      itemType="https://schema.org/Product"
      aria-labelledby={`prod-${product.id}-name`}
      className="w-full md:max-w-[200px] mx-auto"
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
        {/* Image — no border, no shadow, subtle opacity on hover */}
        <div className="relative aspect-square sm:aspect-[3/4] overflow-hidden bg-muted/30 mb-3">
          {/* Platform-level OOS ribbon — minimal pack stays chrome-free
              elsewhere, but the OOS state needs unambiguous communication
              regardless of pack philosophy (2026-05-16). */}
          <OutOfStockRibbon inStock={product.inStock !== false} isRtl={isRtl} />
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
            <Image
              src={product.images[0].url}
              alt={isRtl && product.nameAr ? product.nameAr : product.name}
              className="w-full h-full object-cover group-hover:opacity-85 transition-opacity duration-700 ease-out"
              fill
              sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
              loading="lazy"
            />
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
              'hidden lg:flex absolute bottom-0 inset-x-0 items-center justify-center pb-4 pt-12',
              'bg-gradient-to-t from-background/95 via-background/70 to-transparent',
              'opacity-0 lg:group-hover:opacity-100 transition-opacity duration-500 ease-out'
            )}
            onClick={e => e.preventDefault()}
          >
            <ProductCardCta
              productId={product.id}
              inStock={product.inStock !== false}
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
            />
          </div>
        </div>

        {/* Text — name + price, ultra-minimal */}
        <div className={`flex flex-col gap-2 p-3 sm:p-4 ${isRtl ? 'text-right' : 'text-left'}`}>
          <h3
            id={`prod-${product.id}-name`}
            data-zone="productName"
            className="text-xs tracking-[0.18em] uppercase font-light text-muted-foreground group-hover:text-foreground transition-colors duration-500 ease-out leading-snug"
            itemProp="name"
          >
            {isRtl && product.nameAr ? product.nameAr : product.name}
          </h3>
          <span itemProp="offers" itemScope itemType="https://schema.org/Offer">
            <meta itemProp="priceCurrency" content={currency} />
            <meta itemProp="price" content={String(pricing.displayPrice / 1000)} />
          </span>
          <Price
            price={pricing.displayPrice}
            compareAtPrice={pricing.displayCompare ?? undefined}
            fromPrefix={pricing.mode === 'fromMin'}
            currency={currency}
            isRtl={isRtl}
            size="sm"
            showDiscount={false}
            className="text-[11px] tracking-wide font-light text-muted-foreground"
          />
          {/* Discount indicator — minimal pack stays chrome-free, so use a
            short uppercase 'sale' label inline rather than a badge box. */}
          {hasSale && (
            <p className="text-[10px] tracking-[0.25em] uppercase text-foreground/80">
              {isRtl ? 'تخفيض' : 'Sale'}
            </p>
          )}
          <TaxInclusiveLabel className="block text-[10px] tracking-wide font-light text-muted-foreground/70" />
        </div>
      </Link>
    </article>
  );
}

export default memo(MinimalProductCard, productCardPropsEqual);
