'use client';

import { useT } from '@/i18n/useT';
import type { StockSnapshot } from './types';
import { formatCurrency, formatNumber } from './types';
import { stockValueState } from '@/lib/money-truth';

interface InventorySnapshotCardProps {
  snapshot: StockSnapshot;
}

/**
 * Displays four inventory metrics sourced from backorder_lines and products:
 * stock value, open backorder count, backordered demand value, active reorder rules.
 */
export function InventorySnapshotCard({ snapshot }: InventorySnapshotCardProps) {
  const t = useT('analytics.inventorySnapshot');

  // Unknown is not zero (QA 2026-11-17 N2): stock with no cost price is unknown or partial, never "0".
  const stock = stockValueState(snapshot);
  const rows = [
    {
      label: t('stockValue'),
      value: stock.kind === 'unknown' ? t('stockValueUnknown') : formatCurrency(stock.value),
      note:
        stock.kind === 'unknown'
          ? t('stockValueMissingCost', { count: snapshot.uncostedProducts ?? 0 })
          : stock.kind === 'partial'
            ? t('stockValuePartial', { costed: stock.costed, stocked: stock.stocked })
            : undefined,
      mono: true,
    },
    {
      label: t('openBackorders'),
      value: formatNumber(snapshot.openBackorderCount),
      note: undefined,
      mono: false,
    },
    {
      label: t('backorderedDemandValue'),
      value: formatCurrency(snapshot.backorderedDemandValue),
      note: undefined,
      mono: true,
    },
    {
      label: t('reorderRules'),
      value: formatNumber(snapshot.reorderRulesCount),
      note: undefined,
      mono: false,
    },
  ];

  return (
    <div className="bg-card rounded-md border p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-foreground mb-4">{t('title')}</h2>
      <dl className="grid grid-cols-2 gap-4">
        {rows.map(row => (
          <div key={row.label} className="flex flex-col gap-1">
            <dt className="text-sm text-muted-foreground">{row.label}</dt>
            <dd className="text-base font-semibold text-foreground tabular-nums">{row.value}</dd>
            {row.note && <dd className="text-sm text-muted-foreground">{row.note}</dd>}
          </div>
        ))}
      </dl>
    </div>
  );
}
