'use client';

import { formatPrice } from '../../../../lib/format';

interface StoreStatsCardsProps {
  productsCount: number;
  ordersCount: number;
  customersCount: number;
  revenue: number;
}

export function StoreStatsCards({
  productsCount,
  ordersCount,
  customersCount,
  revenue,
}: StoreStatsCardsProps) {
  return (
    <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
      <div className="rounded-xl border bg-white p-6 shadow-sm">
        <p className="text-sm font-medium text-gray-500">Products</p>
        <p className="mt-1 text-2xl font-bold text-foreground">{productsCount}</p>
      </div>
      <div className="rounded-xl border bg-white p-6 shadow-sm">
        <p className="text-sm font-medium text-gray-500">Orders</p>
        <p className="mt-1 text-2xl font-bold text-foreground">{ordersCount}</p>
      </div>
      <div className="rounded-xl border bg-white p-6 shadow-sm">
        <p className="text-sm font-medium text-gray-500">Customers</p>
        <p className="mt-1 text-2xl font-bold text-foreground">{customersCount}</p>
      </div>
      <div className="rounded-xl border bg-white p-6 shadow-sm">
        <p className="text-sm font-medium text-gray-500">Revenue</p>
        <p className="mt-1 text-2xl font-bold text-primary">{formatPrice(revenue)}</p>
      </div>
    </div>
  );
}
