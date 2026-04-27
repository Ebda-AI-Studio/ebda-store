'use client';

import { memo } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import type { ProductCardProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';
import { CompareButton, RemoveFromWishlistButton } from '../shared/card-actions';
import { Price } from '@force/ui';
import { TaxInclusiveLabel } from '../shared/tax-inclusive-label';
import { productCardPropsEqual } from '../shared/product-card-memo';

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
  urlPrefix = '',

  isInCompare = false,

  onToggleCompare,

  onRemoveFromWishlist,
}: ProductCardProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  return (
    <Link href={`${urlPrefix}/products/${product.slug}`} className="group block cursor-pointer">
      {/* Image — no border, no shadow, subtle opacity on hover */}
      <div className="relative aspect-[3/4] overflow-hidden bg-muted/30 mb-5">
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
            className="w-full h-full object-cover group-hover:opacity-80 transition-opacity duration-300 ease-out"
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
      </div>

      {/* Text — name + price, ultra-minimal */}
      <div className={`space-y-1 ${isRtl ? 'text-right' : 'text-left'}`}>
        <h3 className="text-xs tracking-wide uppercase font-light text-muted-foreground group-hover:text-foreground transition-colors duration-200 leading-snug">
          {isRtl && product.nameAr ? product.nameAr : product.name}
        </h3>
        <Price
          price={product.price}
          compareAtPrice={product.compareAtPrice}
          currency={currency}
          isRtl={isRtl}
          size="sm"
          showDiscount={false}
          className="text-[11px] tracking-wide font-light text-muted-foreground"
        />
        {/* Discount indicator — minimal pack stays chrome-free, so use a
            short uppercase 'sale' label inline rather than a badge box. */}
        {product.compareAtPrice && product.compareAtPrice > product.price && (
          <p className="text-[10px] tracking-[0.25em] uppercase text-foreground/80">
            {isRtl ? 'تخفيض' : 'Sale'}
          </p>
        )}
        <TaxInclusiveLabel className="block text-[10px] tracking-wide font-light text-muted-foreground/70" />
      </div>
    </Link>
  );
}

export default memo(MinimalProductCard, productCardPropsEqual);
