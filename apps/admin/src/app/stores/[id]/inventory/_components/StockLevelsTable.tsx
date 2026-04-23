'use client';

import { useT } from '@/i18n/useT';
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

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
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

      {products.length === 0 ? (
        <div className="p-12 text-center">
          <p className="text-muted-foreground">{t('empty')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full" aria-label={t('tableLabel')}>
            <thead>
              <tr className="bg-muted border-b border-border">
                <th
                  scope="col"
                  className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  {t('columns.product')}
                </th>
                <th
                  scope="col"
                  className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  {t('columns.sku')}
                </th>
                <th
                  scope="col"
                  className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  {t('columns.stock')}
                </th>
                <th
                  scope="col"
                  className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  {t('columns.threshold')}
                </th>
                <th
                  scope="col"
                  className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  {t('columns.status')}
                </th>
                <th
                  scope="col"
                  className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  {t('columns.value')}
                </th>
                <th
                  scope="col"
                  className="text-end px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  {t('columns.actions')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {products.map(product => (
                <tr key={product.id} className="hover:bg-muted">
                  <td className="px-6 py-4">
                    <div>
                      <div className="font-medium text-foreground">{product.name}</div>
                      {product.nameAr && (
                        <div className="text-sm text-muted-foreground font-arabic">
                          {product.nameAr}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">{product.sku || '-'}</td>
                  <td className="px-6 py-4">
                    <span className="font-semibold text-foreground">{product.inventory}</span>
                  </td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">
                    {product.lowStockThreshold}
                  </td>
                  <td className="px-6 py-4">
                    <span
                      className={`px-2 py-1 rounded-full text-xs font-medium ${STOCK_STATUS_STYLES[product.stockStatus].bg} ${STOCK_STATUS_STYLES[product.stockStatus].text}`}
                    >
                      {tStatus(product.stockStatus)}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">
                    {product.costPrice
                      ? t('kwdValue', { value: (product.stockValue / 1000).toFixed(3) })
                      : '-'}
                  </td>
                  <td className="px-6 py-4 text-end">
                    <button
                      onClick={() => onAdjust(product)}
                      className="text-primary hover:text-primary/90 text-sm font-medium"
                    >
                      {t('adjustAction')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
