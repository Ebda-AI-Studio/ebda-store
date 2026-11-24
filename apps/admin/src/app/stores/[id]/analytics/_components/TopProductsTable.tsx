'use client';

import Image from 'next/image';
import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import { formatCurrency, type TopProduct } from './types';

interface TopProductsTableProps {
  products: TopProduct[];
}

/**
 * Leaderboard-style list of the top-5 products by revenue.
 * Renders an image placeholder when a product has no cover photo.
 */
export function TopProductsTable({ products }: TopProductsTableProps) {
  const t = useT('analytics.topProducts');
  const locale = useLocale();
  const isRtl = locale === 'ar';

  return (
    <div className="bg-card rounded-md border p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-foreground mb-4">{t('title')}</h2>
      {products.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <div className="space-y-4">
          {products.map((product, i) => (
            <div key={product.id} className="flex items-center gap-3">
              <span className="text-sm font-medium text-muted-foreground w-4">{i + 1}</span>
              {product.image ? (
                <Image
                  src={product.image}
                  alt={
                    isRtl ? product.nameAr || product.name : product.name || product.nameAr || ''
                  }
                  width={40}
                  height={40}
                  className="w-10 h-10 rounded-md object-cover"
                />
              ) : (
                <div className="w-10 h-10 rounded-md bg-muted flex items-center justify-center">
                  <svg
                    className="w-5 h-5 text-muted-foreground"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                    />
                  </svg>
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">
                  {isRtl ? product.nameAr || product.name : product.name || product.nameAr}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('soldCount', { count: product.quantity })}
                </p>
              </div>
              <span className="text-sm font-semibold text-foreground">
                {formatCurrency(product.revenue)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
