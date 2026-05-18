'use client';

import { memo } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import type { ProductCardProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { useStore } from '../../contexts/StoreContext';
import { resolveColor } from '@force/shared';
import { CompareButton, RemoveFromWishlistButton } from '../shared/card-actions';
import { Price, ProductBadge, cn } from '@force/ui';
import { PlaceholderImageIcon } from '../shared/icons';
import { TaxInclusiveLabel } from '../shared/tax-inclusive-label';
import { productCardPropsEqual } from '../shared/product-card-memo';
import { getProductPricing } from '../../lib/product-pricing';
import { ProductCardCta, OutOfStockRibbon } from '../shared/ProductCardCta';

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
  currency = 'KWD',
  quantityInCart = 0,
  onAddToCart,
  urlPrefix = '',

  isInCompare = false,

  onToggleCompare,

  onRemoveFromWishlist,
  showCardFrame,
  cardFrameStyle: _cardFrameStyle,
  cardFrameColor,
}: ProductCardProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const { store } = useStore();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const handleAddToCart = async (productId: string) => {
    await onAddToCart?.(productId);
  };

  // Variant-aware pricing — see lib/product-pricing.ts.
  const pricing = getProductPricing(product, undefined, 'card');
  const hasSale = !!pricing.displayCompare || pricing.hasVariantDiscount;

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
        {/* Image container — mobile 1:1 (square reads better in 2-up
            grocery grids), desktop 3:4 portrait (per design.md canonical
            product image 600×800). Clean border. */}
        <div className="relative aspect-square sm:aspect-[3/4] overflow-hidden bg-muted border border-border group-hover:border-foreground/35 group-hover:shadow-[0_18px_36px_-22px_hsl(var(--foreground)/0.20)] transition-all duration-500 ease-out mb-3">
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
              className="w-full h-full object-cover group-hover:scale-[1.04] transition-transform duration-700 ease-out"
              fill
              sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"
              loading="lazy"
            />
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
            />
          </div>

          {/* Badges — top corner. Sale badge wins over "new" when both apply
            because shoppers care about price more than recency. */}
          {hasSale ? (
            <ProductBadge
              variant="sale"
              isRtl={isRtl}
              size="sm"
              absolute
              position={isRtl ? 'top-right' : 'top-left'}
              className="font-serif tracking-widest uppercase bg-destructive text-destructive-foreground rounded-none text-[10px]"
              label={isRtl ? 'تخفيض' : 'Sale'}
            />
          ) : (
            product.isNew && (
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
          {/* Platform-level OOS ribbon (red, prominent) — replaces the
              theme-local soldOut badge for visual consistency across
              every theme (2026-05-16). */}
          <OutOfStockRibbon inStock={product.inStock !== false} isRtl={isRtl} />
        </div>

        {/* Product info */}
        <div
          className={`text-center flex flex-col gap-2 p-3 sm:p-4 ${isRtl ? 'direction-rtl' : ''}`}
        >
          <h3
            id={`prod-${product.id}-name`}
            data-zone="productName"
            className="font-serif text-sm md:text-base text-foreground mb-2 group-hover:text-primary transition-colors duration-500 leading-snug tracking-tight"
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
            className="justify-center font-serif text-muted-foreground"
          />
          <TaxInclusiveLabel className="mt-1 block font-serif text-xs text-muted-foreground/70" />
        </div>
      </Link>
    </article>
  );
}

export default memo(ClassicProductCard, productCardPropsEqual);
