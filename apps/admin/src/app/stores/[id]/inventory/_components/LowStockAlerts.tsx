'use client';

import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import { STOCK_STATUS_STYLES, type ProductInventory } from './types';

interface LowStockAlertsProps {
  alerts: ProductInventory[];
  onAdjust: (product: ProductInventory) => void;
}

/**
 * Dedicated view of low-stock and out-of-stock products with a quick
 * "Restock" action that reuses the adjustment modal.
 */
export function LowStockAlerts({ alerts, onAdjust }: LowStockAlertsProps) {
  const t = useT('inventory.alertsTab');
  const tStatus = useT('inventory.status');
  const locale = useLocale();
  const isRtl = locale === 'ar';

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      {alerts.length === 0 ? (
        <div className="p-12 text-center">
          <div className="w-16 h-16 bg-success/10 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg
              className="w-8 h-8 text-success"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-foreground mb-2">{t('emptyTitle')}</h3>
          <p className="text-muted-foreground">{t('emptySubtitle')}</p>
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
                  {t('columns.currentStock')}
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
                  className="text-end px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  {t('columns.actions')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {alerts.map(product => (
                <tr key={product.id} className="hover:bg-muted">
                  <td className="px-6 py-4">
                    <div className="font-medium text-foreground">
                      {isRtl ? product.nameAr || product.name : product.name || product.nameAr}
                    </div>
                    {(isRtl ? product.name : product.nameAr) && (
                      <div className="text-sm text-muted-foreground font-arabic">
                        {isRtl ? product.name : product.nameAr}
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">{product.sku || '-'}</td>
                  <td className="px-6 py-4">
                    <span
                      className={`font-semibold ${product.inventory <= 0 ? 'text-destructive' : 'text-warning'}`}
                    >
                      {product.inventory}
                    </span>
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
                  <td className="px-6 py-4 text-end">
                    <button
                      type="button"
                      onClick={() => onAdjust(product)}
                      className="px-3 py-1 bg-primary text-white rounded-lg hover:bg-primary/90 text-sm font-medium"
                    >
                      {t('restockAction')}
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
