'use client';

import Image from 'next/image';
import { useT } from '@/i18n/useT';
import { useLocale } from 'next-intl';
import type { LowStockProduct } from './types';

interface LowStockAlertsCardProps {
  products: LowStockProduct[];
}

/**
 * Shows up to 5 products below the low-stock threshold. Inventory chip color
 * escalates: out-of-stock (destructive) → critical (primary) → warning.
 * When empty, renders a reassuring check-mark illustration.
 */
export function LowStockAlertsCard({ products }: LowStockAlertsCardProps) {
  const t = useT('analytics.lowStock');
  const isAr = useLocale() === 'ar';
  // STORE-QA-8: the product's name in the page language, the same one the products list shows.
  const nameOf = (p: { name: string; nameAr?: string | null }) => (isAr && p.nameAr) || p.name;

  return (
    <div className="bg-card rounded-xl border p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-foreground mb-4">{t('title')}</h2>
      {products.length === 0 ? (
        <div className="text-center py-4">
          <svg
            className="w-12 h-12 text-success/60 mx-auto mb-2"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <p className="text-muted-foreground text-sm">{t('allStocked')}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {products.slice(0, 5).map(product => (
            <div key={product.id} className="flex items-center gap-3">
              {product.images?.[0]?.url ? (
                <Image
                  src={product.images[0].url}
                  alt={nameOf(product)}
                  width={40}
                  height={40}
                  className="w-10 h-10 rounded object-cover"
                />
              ) : (
                <div className="w-10 h-10 rounded bg-muted flex items-center justify-center">
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
                      d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                    />
                  </svg>
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{nameOf(product)}</p>
                <p className="text-xs text-muted-foreground">{product.sku}</p>
                {/* Backorder enrichment — shown when Batch 2 data is present */}
                <div className="flex flex-wrap gap-1 mt-1">
                  {(product.openBackorderCount ?? 0) > 0 && (
                    <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-warning/10 text-warning-ink">
                      {t('openBackorders', { count: product.openBackorderCount ?? 0 })}
                    </span>
                  )}
                  {product.acceptsBackorder && (
                    <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                      {t('acceptsBackorder')}
                    </span>
                  )}
                  {product.reorderRule && (
                    <span className="px-1.5 py-0.5 text-xs text-muted-foreground rounded bg-muted">
                      {t('reorderRule', {
                        min: product.reorderRule.minQty,
                        qty: product.reorderRule.reorderQty,
                        lead: product.reorderRule.leadTimeDays,
                      })}
                    </span>
                  )}
                </div>
              </div>
              <span
                className={`px-2 py-1 text-xs font-semibold rounded shrink-0 ${
                  product.inventory === 0
                    ? 'bg-destructive/10 text-destructive-ink dark:bg-destructive/30 dark:text-destructive-ink'
                    : product.inventory <= 5
                      ? 'bg-primary/10 text-primary-ink'
                      : 'bg-warning/10 text-warning-ink dark:bg-warning/30 dark:text-warning-ink'
                }`}
              >
                {t('unitsLeft', { count: product.inventory })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
