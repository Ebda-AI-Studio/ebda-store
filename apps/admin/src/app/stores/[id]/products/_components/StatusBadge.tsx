'use client';

import { OrderStatusBadge } from '@/components/OrderStatusBadge';

interface StatusBadgeProps {
  status: string;
}

/** Catalogue status (active / draft / archived) through the shared status-tone registry. */
export function StatusBadge({ status }: StatusBadgeProps) {
  return <OrderStatusBadge family="product" status={status} />;
}
