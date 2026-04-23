'use client';

import { useT } from '@/i18n/useT';
import type { InventoryStats } from './types';

interface InventoryStatsCardsProps {
  stats: InventoryStats;
}

/**
 * Renders the five KPI cards summarising inventory counts and value.
 */
export function InventoryStatsCards({ stats }: InventoryStatsCardsProps) {
  const t = useT('inventory.stats');

  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
      <div className="bg-card rounded-xl border border-border p-4">
        <p className="text-sm text-muted-foreground">{t('totalProducts')}</p>
        <p className="text-2xl font-bold text-foreground">{stats.totalProducts}</p>
      </div>
      <div className="bg-card rounded-xl border border-border p-4">
        <p className="text-sm text-muted-foreground">{t('totalStock')}</p>
        <p className="text-2xl font-bold text-info">{stats.totalStock.toLocaleString()}</p>
      </div>
      <div className="bg-card rounded-xl border border-border p-4">
        <p className="text-sm text-muted-foreground">{t('lowStock')}</p>
        <p className="text-2xl font-bold text-warning">{stats.lowStockCount}</p>
      </div>
      <div className="bg-card rounded-xl border border-border p-4">
        <p className="text-sm text-muted-foreground">{t('outOfStock')}</p>
        <p className="text-2xl font-bold text-destructive">{stats.outOfStockCount}</p>
      </div>
      <div className="bg-card rounded-xl border border-border p-4">
        <p className="text-sm text-muted-foreground">{t('stockValue')}</p>
        <p className="text-2xl font-bold text-success">
          {t('kwdValue', { value: (stats.totalValue / 1000).toFixed(3) })}
        </p>
      </div>
    </div>
  );
}
