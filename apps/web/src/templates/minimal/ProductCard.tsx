'use client';

import Link from 'next/link';
import type { ProductCardProps } from '../types';
import { Price } from '@force/ui';

/**
 * Minimal Template - Product Card
 *
 * Ultra-clean design with maximum whitespace.
 * No hover effects, no badges - pure product focus.
 * Uses shared components from @force/ui.
 */
export default function MinimalProductCard({
  product,
  isRtl = false,
  currency = 'KWD',
}: ProductCardProps) {
  return (
    <Link href={`/products/${product.slug}`} className="group block">
      {/* Image - Full bleed, no borders */}
      <div className="relative aspect-[3/4] overflow-hidden bg-muted/30 mb-6">
        {product.images?.[0]?.url ? (
          <img
            src={product.images[0].url}
            alt={isRtl && product.nameAr ? product.nameAr : product.name}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground/30">
            <svg
              className="w-12 h-12"
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

      {/* Content - Minimal text */}
      <div className="space-y-1">
        <h3 className="text-xs tracking-wide uppercase font-light text-muted-foreground group-hover:text-foreground transition-colors">
          {isRtl && product.nameAr ? product.nameAr : product.name}
        </h3>
        <Price
          price={product.price}
          currency={currency}
          isRtl={isRtl}
          size="sm"
          showDiscount={false}
          className="text-xs tracking-wide font-light"
        />
      </div>
    </Link>
  );
}
