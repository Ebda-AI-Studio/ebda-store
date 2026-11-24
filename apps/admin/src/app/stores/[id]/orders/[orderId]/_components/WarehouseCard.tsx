'use client';

import { useT } from '@/i18n/useT';
import type { OrderDetail, WarehouseAllocation } from './types';

interface WarehouseCardProps {
  order: OrderDetail;
}

/** Ruling WAREHOUSE-ROUTE-1: the warehouse(s) this order's stock was taken from. Hidden on single-warehouse stores. */
export function WarehouseCard({ order }: WarehouseCardProps) {
  const t = useT('orders.detail');
  const rows = order.warehouseAllocations ?? [];
  if (rows.length === 0) return null;
  const name = (productId: string) =>
    order.items?.find(i => i.productId === productId)?.productName ?? productId;
  // Ruling WAREHOUSE-ROUTE-3: one line can ship from several warehouses; show it once with every warehouse and its quantity
  const lines = new Map<string, { productId: string; parts: WarehouseAllocation[] }>();
  for (const r of rows) {
    const key = r.orderItemId ?? `${r.productId}:${r.variantId ?? ''}`;
    const line = lines.get(key) ?? { productId: r.productId, parts: [] };
    line.parts.push(r);
    lines.set(key, line);
  }
  const grouped = [...lines.values()];
  const isSplit = grouped.some(l => l.parts.length > 1);

  return (
    <section className="rounded-lg border border-border bg-card p-5 space-y-3">
      <h3 className="text-sm font-medium text-muted-foreground">{t('fulfilledFrom')}</h3>
      <ul className="space-y-1.5 text-sm">
        {grouped.map((l, i) => (
          <li key={i} className="flex items-center justify-between gap-3">
            <span className="truncate text-foreground">{name(l.productId)}</span>
            <span className="shrink-0 text-muted-foreground" data-testid="warehouse-split">
              {l.parts.map(r => `${r.warehouseCode} x${r.quantity}`).join(', ')}
            </span>
          </li>
        ))}
      </ul>
      {isSplit && <p className="text-sm text-muted-foreground">{t('splitHint')}</p>}
    </section>
  );
}
