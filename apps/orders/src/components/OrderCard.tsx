'use client';

import Link from 'next/link';
import type { Order } from '@/lib/orders';
import { StatusBadge } from './StatusBadge';
import { formatMoney, formatDateTime, customerName } from '@/lib/format';
import { useLanguage } from '@/contexts/LanguageContext';

import { REGION } from '@force/shared';
export function OrderCard({ order, storeId }: { order: Order; storeId: string }) {
  const { t, locale } = useLanguage();
  const itemCount = order.items?.reduce((sum, i) => sum + (i.quantity ?? 0), 0) ?? 0;

  // Item 16: the customer NAME is the prominent OUTSIDE line; the order number is
  // shrunk to a secondary line here and shown in full on the detail page. Guest
  // orders (no name) fall back to the order ref as the primary line so the card
  // never shows an empty heading.
  const orderRef = order.orderNumber ?? order.id.slice(0, 8);
  // Guest orders carry no `customer` row — fall back to the name the shopper
  // entered in the shipping address (then their email) so the card always shows
  // a real name, not just the order ref.
  const addr = order.shippingAddress;
  const guestName = addr ? `${addr.firstName ?? ''} ${addr.lastName ?? ''}`.trim() : '';
  const name = customerName(order.customer, '') || guestName || addr?.email || '';
  const primaryLine = name || orderRef;
  const secondaryRef = name ? orderRef : null;

  return (
    <Link
      href={`/orders/${order.id}?store=${storeId}`}
      className="block min-h-[56px] rounded-2xl border border-border bg-card p-4 shadow-sm transition-colors active:bg-muted/50 active:scale-[0.99]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold leading-snug text-foreground">{primaryLine}</p>
          {secondaryRef && (
            <p className="mt-0.5 truncate text-xs leading-snug text-muted-foreground">
              {secondaryRef}
            </p>
          )}
        </div>
        <StatusBadge status={order.status} />
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="text-xs leading-relaxed text-muted-foreground">
          <p>{formatDateTime(order.createdAt, locale)}</p>
          {itemCount > 0 && (
            <p>
              {itemCount} {t.orders.items}
            </p>
          )}
        </div>
        <div className="text-end">
          <p className="text-base font-bold leading-tight text-foreground">
            {formatMoney(order.total, order.currency ?? REGION.currency)}
          </p>
          {order.paymentStatus === 'paid' ? (
            <p className="text-xs font-semibold text-success-ink">{t.filters.paid}</p>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
