'use client';

import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { STOCK_STATUS_STYLES, type ProductInventory, type StockFilter } from './types';

interface StockLevelsTableProps {
  products: ProductInventory[];
  search: string;
  stockFilter: StockFilter;
  onSearchChange: (value: string) => void;
  onFilterChange: (filter: StockFilter) => void;
  onAdjust: (product: ProductInventory) => void;
}

const FILTERS: StockFilter[] = ['all', 'in_stock', 'low_stock', 'out_of_stock'];

/**
 * Product inventory table with search + stock-status filter pills.
 * Each row exposes an "Adjust" action handled by the parent.
 * Uses the shared DataTable primitive so it stacks to cards on mobile (<md).
 */
export function StockLevelsTable({
  products,
  search,
  stockFilter,
  onSearchChange,
  onFilterChange,
  onAdjust,
}: StockLevelsTableProps) {
  const t = useT('inventory.levels');
  const tStatus = useT('inventory.status');
  const locale = useLocale();
  const isRtl = locale === 'ar';

  const columns: DataTableColumn<ProductInventory>[] = [
    {
      header: t('columns.product'),
      primaryOnMobile: true,
      cell: product => (
        <div>
          <div className="font-medium text-foreground">
            {isRtl ? product.nameAr || product.name : product.name || product.nameAr}
          </div>
          {(isRtl ? product.name : product.nameAr) && (
            <div className="text-sm text-muted-foreground font-arabic">
              {isRtl ? product.name : product.nameAr}
            </div>
          )}
        </div>
      ),
    },
    {
      header: t('columns.status'),
      mobileBadge: true,
      cell: product => (
        <span
          className={`px-2 py-1 rounded-full text-xs font-medium ${STOCK_STATUS_STYLES[product.stockStatus].bg} ${STOCK_STATUS_STYLES[product.stockStatus].text}`}
        >
          {tStatus(product.stockStatus)}
        </span>
      ),
    },
    {
      header: t('columns.sku'),
      cell: product => <span className="text-sm text-muted-foreground">{product.sku || '-'}</span>,
    },
    {
      header: t('columns.stock'),
      alignEnd: true,
      cell: product => <span className="font-semibold text-foreground">{product.inventory}</span>,
    },
    {
      header: t('columns.threshold'),
      alignEnd: true,
      cell: product => (
        <span className="text-sm text-muted-foreground">{product.lowStockThreshold}</span>
      ),
    },
    {
      header: t('columns.value'),
      alignEnd: true,
      cell: product => (
        <span className="text-sm text-muted-foreground">
          {product.costPrice
            ? t('kwdValue', { value: (product.stockValue / 1000).toFixed(3) })
            : '-'}
        </span>
      ),
    },
    {
      header: t('columns.actions'),
      alignEnd: true,
      mobileActions: true,
      cell: product => (
        <button
          type="button"
          onClick={() => onAdjust(product)}
          className="min-h-11 inline-flex items-center px-3 py-2 text-primary hover:text-primary/90 text-sm font-medium"
        >
          {t('adjustAction')}
        </button>
      ),
    },
  ];

  const emptyState = (
    <div className="force-empty-state px-6">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
        <svg
          className="h-8 w-8 text-muted-foreground"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
          />
        </svg>
      </div>
      <p className="font-semibold text-foreground">{t('empty')}</p>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{t('emptyDescription')}</p>
    </div>
  );

  return (
    <div className="rounded-xl border border-border overflow-hidden">
      {/* Search + filter toolbar */}
      <div className="flex flex-wrap gap-4 p-4 bg-muted border-b border-border">
        <div className="flex-1 min-w-[200px]">
          <input
            type="text"
            placeholder={t('searchPlaceholder')}
            value={search}
            onChange={e => onSearchChange(e.target.value)}
            className="w-full px-4 py-2 border border-border rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
          />
        </div>
        <div className="flex gap-2">
          {FILTERS.map(filter => (
            <button
              type="button"
              key={filter}
              onClick={() => onFilterChange(filter)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                stockFilter === filter
                  ? 'bg-primary text-white'
                  : 'bg-card text-foreground hover:bg-muted border border-border'
              }`}
            >
              {filter === 'all' ? t('filters.all') : tStatus(filter)}
            </button>
          ))}
        </div>
      </div>

      <DataTable columns={columns} rows={products} rowKey={p => p.id} emptyState={emptyState} />
    </div>
  );
}
