'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useT } from '@/i18n/useT';
import type { InventoryStats } from './types';

interface InventoryStatsCardsProps {
  stats: InventoryStats;
}

/**
 * Renders the five KPI cards summarising inventory counts and value.
 *
 * Each card navigates to the most relevant existing admin page:
 *   - Total Products  → /stores/[id]/products
 *   - Total Stock     → /stores/[id]/stock/inventory (full stock list)
 *   - Low Stock       → /stores/[id]/stock/inventory?filter=low_stock
 *   - Out of Stock    → /stores/[id]/stock/inventory?filter=out_of_stock
 *   - Stock Value     → /stores/[id]/stock/dashboard
 */
export function InventoryStatsCards({ stats }: InventoryStatsCardsProps) {
  const t = useT('inventory.stats');
  const params = useParams<{ id: string }>();
  const storeId = params.id;

  const cardBase =
    'bg-card rounded-xl border border-border p-4 cursor-pointer transition-colors hover:border-primary/40 hover:bg-card/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
      {/* Total Products → products listing */}
      <Link href={`/stores/${storeId}/products`} className={cardBase}>
        <p className="text-sm text-muted-foreground">{t('totalProducts')}</p>
        <p className="text-2xl font-bold text-foreground">{stats.totalProducts}</p>
      </Link>

      {/* Total Stock → full inventory list */}
      <Link href={`/stores/${storeId}/stock/inventory`} className={cardBase}>
        <p className="text-sm text-muted-foreground">{t('totalStock')}</p>
        <p className="text-2xl font-bold text-info">{stats.totalStock.toLocaleString()}</p>
      </Link>

      {/* Low Stock → inventory list pre-filtered to low_stock */}
      <Link href={`/stores/${storeId}/stock/inventory?filter=low_stock`} className={cardBase}>
        <p className="text-sm text-muted-foreground">{t('lowStock')}</p>
        <p className="text-2xl font-bold text-warning">{stats.lowStockCount}</p>
      </Link>

      {/* Out of Stock → inventory list pre-filtered to out_of_stock */}
      <Link href={`/stores/${storeId}/stock/inventory?filter=out_of_stock`} className={cardBase}>
        <p className="text-sm text-muted-foreground">{t('outOfStock')}</p>
        <p className="text-2xl font-bold text-destructive">{stats.outOfStockCount}</p>
      </Link>

      {/* Stock Value → stock dashboard (finance summary) */}
      <Link href={`/stores/${storeId}/stock/dashboard`} className={cardBase}>
        <p className="text-sm text-muted-foreground">{t('stockValue')}</p>
        <p className="text-2xl font-bold text-success">
          {t('kwdValue', { value: (stats.totalValue / 1000).toFixed(3) })}
        </p>
      </Link>
    </div>
  );
}
