'use client';

import Link from 'next/link';
import Image from 'next/image';
import type { Product } from '@/lib/api';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { formatPrice } from '@/lib/format';

interface ProductListItemProps {
  product: Product;
  isInCompare: boolean;
  onToggleCompare: (product: Product, e: React.MouseEvent) => void;
  onAddToCart: (product: Product, e: React.MouseEvent) => void;
}

export function ProductListItem({
  product,
  isInCompare,
  onToggleCompare,
  onAddToCart,
}: ProductListItemProps) {
  const { t } = useLanguage();

  return (
    <Link
      href={`/products/${product.slug}`}
      className="flex gap-4 rounded-2xl border border-border bg-card p-4 transition-all hover:border-primary/30 hover:shadow-lg"
    >
      {/* Image */}
      <div className="relative h-32 w-32 flex-shrink-0 overflow-hidden rounded-xl bg-gradient-to-br from-primary/5 to-primary/10">
        {product.compareAtPrice && product.compareAtPrice > product.price && (
          <span className="absolute left-2 top-2 rounded-full bg-destructive px-2 py-0.5 text-[10px] font-bold uppercase text-white">
            Sale
          </span>
        )}
        {product.images?.[0]?.url ? (
          <Image
            src={product.images[0].url}
            alt={product.images[0].alt || product.name}
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
              {product.categories[0].category?.name}
            </p>
          )}
          <h3 className="mt-1 text-lg font-semibold text-foreground">{product.name}</h3>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl font-bold text-primary">{formatPrice(product.price)}</span>
            {product.compareAtPrice && product.compareAtPrice > product.price && (
              <span className="text-sm text-muted-foreground line-through">
                {formatPrice(product.compareAtPrice)}
              </span>
            )}
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

            <button
              className="flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary/90"
              onClick={e => onAddToCart(product, e)}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
                />
              </svg>
              {t('Add to Cart', translations['Add to Cart'])}
            </button>
          </div>
        </div>
      </div>
    </Link>
  );
}
