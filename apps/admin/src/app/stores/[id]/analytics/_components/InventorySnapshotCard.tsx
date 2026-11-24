'use client';

import { useT } from '@/i18n/useT';
import type { StockSnapshot } from './types';
import { formatCurrency, formatNumber } from './types';

interface InventorySnapshotCardProps {
  snapshot: StockSnapshot;
}

/**
 * Displays four inventory metrics sourced from backorder_lines and products:
 * stock value, open backorder count, backordered demand value, active reorder rules.
 */
export function InventorySnapshotCard({ snapshot }: InventorySnapshotCardProps) {
  const t = useT('analytics.inventorySnapshot');

  const rows = [
    { label: t('stockValue'), value: formatCurrency(snapshot.stockValue), mono: true },
    { label: t('openBackorders'), value: formatNumber(snapshot.openBackorderCount), mono: false },
    {
      label: t('backorderedDemandValue'),
      value: formatCurrency(snapshot.backorderedDemandValue),
      mono: true,
    },
    { label: t('reorderRules'), value: formatNumber(snapshot.reorderRulesCount), mono: false },
  ] as const;

  return (
    <div className="bg-card rounded-md border p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-foreground mb-4">{t('title')}</h2>
      <dl className="grid grid-cols-2 gap-4">
        {rows.map(row => (
          <div key={row.label} className="flex flex-col gap-1">
            <dt className="text-sm text-muted-foreground">{row.label}</dt>
            <dd className="text-base font-semibold text-foreground tabular-nums">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
