'use client';

import { useT } from '@/i18n/useT';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { HISTORY_TYPE_KEYS, type HistoryItem } from './types';

interface StockMovementLogProps {
  history: HistoryItem[];
}

/**
 * Read-only log of stock adjustments. Each row shows the change type,
 * quantity delta (colour-coded), and transition from previous to new stock.
 * Uses the shared DataTable primitive so it stacks to cards on mobile (<md).
 */
export function StockMovementLog({ history }: StockMovementLogProps) {
  const t = useT('inventory.history');
  const tTypes = useT('inventory.historyTypes');

  const formatType = (type: string): string => {
    return (HISTORY_TYPE_KEYS as readonly string[]).includes(type) ? tTypes(type) : type;
  };

  const columns: DataTableColumn<HistoryItem>[] = [
    {
      header: t('columns.product'),
      primaryOnMobile: true,
      cell: item => (
        <div>
          <div className="font-medium text-foreground">{item.product?.name || '-'}</div>
          {item.product?.sku && (
            <div className="text-xs text-muted-foreground">{item.product.sku}</div>
          )}
        </div>
      ),
    },
    {
      header: t('columns.change'),
      mobileBadge: true,
      cell: item => (
        <span className={`font-medium ${item.quantity >= 0 ? 'text-success' : 'text-destructive'}`}>
          {item.quantity >= 0 ? '+' : ''}
          {item.quantity}
        </span>
      ),
    },
    {
      header: t('columns.date'),
      cell: item => (
        <span className="text-sm text-muted-foreground">
          {new Date(item.createdAt).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
      ),
    },
    {
      header: t('columns.type'),
      cell: item => <span className="text-sm text-muted-foreground">{formatType(item.type)}</span>,
    },
    {
      header: t('columns.stock'),
      cell: item => (
        <span className="text-sm text-muted-foreground">
          {item.previousStock} → {item.newStock}
        </span>
      ),
    },
    {
      header: t('columns.reason'),
      cell: item => <span className="text-sm text-muted-foreground">{item.reason || '-'}</span>,
    },
  ];

  const emptyState = (
    <div className="p-12 text-center">
      <p className="text-muted-foreground">{t('empty')}</p>
    </div>
  );

  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <DataTable
        columns={columns}
        rows={history}
        rowKey={item => item.id}
        emptyState={emptyState}
      />
    </div>
  );
}
