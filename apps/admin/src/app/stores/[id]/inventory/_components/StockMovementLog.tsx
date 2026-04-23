'use client';

import { useT } from '@/i18n/useT';
import { HISTORY_TYPE_KEYS, type HistoryItem } from './types';

interface StockMovementLogProps {
  history: HistoryItem[];
}

/**
 * Read-only log of stock adjustments. Each row shows the change type,
 * quantity delta (colour-coded), and transition from previous to new stock.
 */
export function StockMovementLog({ history }: StockMovementLogProps) {
  const t = useT('inventory.history');
  const tTypes = useT('inventory.historyTypes');

  const formatType = (type: string): string => {
    return (HISTORY_TYPE_KEYS as readonly string[]).includes(type) ? tTypes(type) : type;
  };

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      {history.length === 0 ? (
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
                  {t('columns.date')}
                </th>
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
                  {t('columns.type')}
                </th>
                <th
                  scope="col"
                  className="text-start px-6 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                >
                  {t('columns.change')}
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
                  {t('columns.reason')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {history.map(item => (
                <tr key={item.id} className="hover:bg-muted">
                  <td className="px-6 py-4 text-sm text-muted-foreground">
                    {new Date(item.createdAt).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                  <td className="px-6 py-4">
                    <div className="font-medium text-foreground">{item.product?.name || '-'}</div>
                    {item.product?.sku && (
                      <div className="text-xs text-muted-foreground">{item.product.sku}</div>
                    )}
                  </td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">
                    {formatType(item.type)}
                  </td>
                  <td className="px-6 py-4">
                    <span
                      className={`font-medium ${item.quantity >= 0 ? 'text-success' : 'text-destructive'}`}
                    >
                      {item.quantity >= 0 ? '+' : ''}
                      {item.quantity}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">
                    {item.previousStock} → {item.newStock}
                  </td>
                  <td className="px-6 py-4 text-sm text-muted-foreground">{item.reason || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
