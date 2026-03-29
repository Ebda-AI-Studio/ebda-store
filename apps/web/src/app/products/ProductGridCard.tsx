'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import type { Product } from '@/lib/api';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { formatPrice } from '@/lib/format';

interface ProductGridCardProps {
  product: Product;
  index: number;
  isInCompare: boolean;
  onToggleCompare: (product: Product, e: React.MouseEvent) => void;
  onAddToCart: (product: Product, e: React.MouseEvent) => void;
}

export function ProductGridCard({
  product,
  index,
  isInCompare,
  onToggleCompare,
  onAddToCart,
}: ProductGridCardProps) {
  const { t } = useLanguage();
  const [isAdding, setIsAdding] = useState(false);

  // Treat inventory === 0 as out of stock; undefined/null means untracked (in stock)
  const isOutOfStock =
    product.inventory !== undefined && product.inventory !== null && product.inventory <= 0;

  return (
    <Link
      href={`/products/${product.slug}`}
      className={`product-card group ${isOutOfStock ? 'opacity-60' : ''}`}
      style={{ animationDelay: `${index * 50}ms` }}
    >
      {/* Badges */}
      {isOutOfStock ? (
        <span className="product-badge bg-muted-foreground text-white">
          {t('Sold Out', '\u0646\u0641\u0630')}
        </span>
      ) : product.compareAtPrice && product.compareAtPrice > product.price ? (
        <span className="product-badge bg-destructive">Sale</span>
      ) : null}

      {/* Wishlist Button */}
      <button
        className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-card/90 text-muted-foreground opacity-0 shadow-md backdrop-blur-sm transition-all hover:bg-primary hover:text-white group-hover:opacity-100"
        aria-label={t(
          'Add to wishlist',
          '\u0623\u0636\u0641 \u0625\u0644\u0649 \u0627\u0644\u0645\u0641\u0636\u0644\u0629'
        )}
        onClick={e => {
          e.preventDefault();
        }}
      >
        <svg
          className="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
          />
        </svg>
        <span className="sr-only">
          {t(
            'Add to wishlist',
            '\u0623\u0636\u0641 \u0625\u0644\u0649 \u0627\u0644\u0645\u0641\u0636\u0644\u0629'
          )}
        </span>
      </button>

      {/* Compare Button */}
      <button
        aria-label={isInCompare ? 'Remove from compare' : 'Add to compare'}
        title={isInCompare ? 'Remove from compare' : 'Add to compare'}
        className={`absolute left-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full shadow-md backdrop-blur-sm transition-all opacity-0 group-hover:opacity-100 ${
          isInCompare
            ? 'bg-primary text-white'
            : 'bg-card/90 text-muted-foreground hover:bg-primary hover:text-white'
        }`}
        onClick={e => onToggleCompare(product, e)}
      >
        {/* Bar-chart compare icon */}
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

      {/* Image */}
      <div className="relative aspect-square overflow-hidden bg-gradient-to-br from-primary/5 to-primary/10">
        {product.images?.[0]?.url ? (
          <Image
            src={product.images[0].url}
            alt={product.images[0].alt || product.name}
            width={500}
            height={500}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-110"
            sizes="(max-width: 640px) 100vw, (max-width: 1280px) 50vw, 33vw"
          />
        ) : (
          <div className="flex h-full items-center justify-center transition-transform duration-300 group-hover:scale-110">
            <div className="flex h-24 w-24 items-center justify-center rounded-full bg-primary/10">
              <svg
                className="h-12 w-12 text-primary"
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

        {/* Quick Actions */}
        {!isOutOfStock && (
          <div className="absolute inset-x-0 bottom-0 translate-y-full p-3 transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100">
            <button
              className="add-to-cart-btn"
              disabled={isAdding}
              onClick={async e => {
                e.preventDefault();
                if (isAdding) return;
                setIsAdding(true);
                try {
                  onAddToCart(product, e);
                } finally {
                  // Brief delay so user sees the loading state
                  setTimeout(() => setIsAdding(false), 600);
                }
              }}
            >
              {isAdding ? (
                <>
                  <svg className="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  {t(
                    'Adding...',
                    '\u062c\u0627\u0631\u064a \u0627\u0644\u0625\u0636\u0627\u0641\u0629...'
                  )}
                </>
              ) : (
                <>
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
                    />
                  </svg>
                  {t('Add to Cart', translations['Add to Cart'])}
                </>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="p-4">
        {product.categories?.[0] && (
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {product.categories[0].category?.name}
          </p>
        )}
        <h3 className="mt-1 line-clamp-2 font-semibold text-foreground transition-colors group-hover:text-primary">
          {product.name}
        </h3>

        {/* Price */}
        <div className="mt-3 flex items-center gap-2">
          <span className="text-lg font-bold text-primary">{formatPrice(product.price)}</span>
          {product.compareAtPrice && product.compareAtPrice > product.price && (
            <span className="text-sm text-muted-foreground line-through">
              {formatPrice(product.compareAtPrice)}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
