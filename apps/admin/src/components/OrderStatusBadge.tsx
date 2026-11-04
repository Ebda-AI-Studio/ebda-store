'use client';

import { useT } from '@/i18n/useT';

type OrderStatus =
  | 'pending'
  | 'awaiting_payment_confirmation'
  | 'confirmed'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'refunded'
  | 'paid'
  | 'unpaid'
  | (string & {});

/**
 * Per-status color contract. Return either the legacy 3-slot shape used by
 * the default orders palette (bg/text/dot, rendered with a colored dot) or a
 * single `className` string used by the consolidated return/shipment/cart/
 * notification palettes (no dot, single rounded pill). The unified component
 * below handles both rendering paths based on which shape the colorMap entry
 * provides.
 */
export type StatusStyle = { bg: string; text: string; dot: string } | { className: string };

const DEFAULT_STATUS_STYLES: Record<string, StatusStyle> = {
  pending: { bg: 'bg-warning/10', text: 'text-warning-ink', dot: 'bg-warning' },
  // InstaPay: the money has not been confirmed to have arrived (SP6a).
  awaiting_payment_confirmation: {
    bg: 'bg-violet-50',
    text: 'text-violet-700',
    dot: 'bg-violet-500',
  },
  confirmed: { bg: 'bg-cyan-50', text: 'text-cyan-700', dot: 'bg-cyan-500' },
  processing: { bg: 'bg-info/5', text: 'text-info-ink', dot: 'bg-info' },
  shipped: { bg: 'bg-violet-50', text: 'text-violet-700', dot: 'bg-violet-500' },
  delivered: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  cancelled: { bg: 'bg-destructive/5', text: 'text-destructive-ink', dot: 'bg-destructive' },
  refunded: { bg: 'bg-muted', text: 'text-muted-foreground', dot: 'bg-muted-foreground' },
  paid: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  unpaid: { bg: 'bg-warning/10', text: 'text-warning-ink', dot: 'bg-warning' },
};

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
  /**
   * Override the color table. When provided, entries in this map take priority
   * over the default orders palette. Lets surfaces with their own status
   * vocabulary (returns, shipments, abandoned carts, notifications) reuse this
   * component without forking the rendering logic. Unknown statuses fall back
   * to a muted neutral pill.
   */
  colorMap?: Record<string, StatusStyle>;
}

const FALLBACK_STYLE: StatusStyle = { className: 'bg-muted text-foreground' };

/**
 * Shared status badge used across orders, returns, shipments, abandoned-cart
 * and notification surfaces. The default (orders) palette uses a dotted pill;
 * alternate palettes supplied via `colorMap` can use the single-className
 * shape for a flat pill.
 */
export function OrderStatusBadge({
  status,
  namespace = 'orders.status',
  label,
  colorMap,
}: OrderStatusBadgeProps) {
  const t = useT(namespace);
  const style =
    colorMap?.[status] ??
    (colorMap ? FALLBACK_STYLE : (DEFAULT_STATUS_STYLES[status] ?? DEFAULT_STATUS_STYLES.pending));
  // Fall back to the raw status if the namespace has no matching key, so that new
  // backend statuses render something sensible before translations catch up.
  const text = label ?? (t.has(status) ? t(status) : status);

  if ('className' in style) {
    return (
      <span
        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ${style.className}`}
      >
        {text}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${style.bg} ${style.text}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
      {text}
    </span>
  );
}
