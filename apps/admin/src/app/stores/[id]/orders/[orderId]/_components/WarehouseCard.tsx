'use client';

import { useT } from '@/i18n/useT';
import type { OrderDetail } from './types';

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

  return (
    <section className="rounded-2xl border border-border bg-card p-5 space-y-3">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {t('fulfilledFrom')}
      </h3>
      <ul className="space-y-1.5 text-sm">
        {rows.map((r, i) => (
          <li key={i} className="flex items-center justify-between gap-3">
            <span className="truncate text-foreground">{name(r.productId)}</span>
            <span className="shrink-0 text-muted-foreground">
              {r.warehouseCode} · {r.quantity}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
