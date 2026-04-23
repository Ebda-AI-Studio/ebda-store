'use client';

import { useT } from '@/i18n/useT';

type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'refunded'
  | 'paid'
  | 'unpaid'
  | (string & {});

interface StatusStyle {
  bg: string;
  text: string;
  dot: string;
}

const STATUS_STYLES: Record<string, StatusStyle> = {
  pending: { bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500' },
  confirmed: { bg: 'bg-cyan-50', text: 'text-cyan-700', dot: 'bg-cyan-500' },
  processing: { bg: 'bg-info/5', text: 'text-info', dot: 'bg-info' },
  shipped: { bg: 'bg-violet-50', text: 'text-violet-700', dot: 'bg-violet-500' },
  delivered: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  cancelled: { bg: 'bg-destructive/5', text: 'text-destructive', dot: 'bg-destructive' },
  refunded: { bg: 'bg-muted', text: 'text-muted-foreground', dot: 'bg-muted-foreground' },
  paid: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  unpaid: { bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500' },
};

function getStatusStyle(status: string): StatusStyle {
  return STATUS_STYLES[status] ?? STATUS_STYLES.pending;
}

interface OrderStatusBadgeProps {
  /** Raw status value (used to pick colors and as the default label key). */
  status: OrderStatus;
  /**
   * Translation namespace to look up the label under. Defaults to `orders.status`.
   * The badge renders the translation at `<namespace>.<status>` — callers can swap
   * the namespace (e.g. returns/abandoned-carts) without changing this component.
   */
  namespace?: string;
  /** Optional override rendered instead of the translated label. */
  label?: string;
}

/**
 * Shared status badge used across orders, returns and abandoned-cart surfaces.
 * Keep the color table here so every surface stays visually consistent.
 */
export function OrderStatusBadge({
  status,
  namespace = 'orders.status',
  label,
}: OrderStatusBadgeProps) {
  const t = useT(namespace);
  const style = getStatusStyle(status);
  // Fall back to the raw status if the namespace has no matching key, so that new
  // backend statuses render something sensible before translations catch up.
  const text = label ?? (t.has(status) ? t(status) : status);

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${style.bg} ${style.text}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
      {text}
    </span>
  );
}
