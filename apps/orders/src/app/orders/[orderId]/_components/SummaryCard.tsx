'use client';

import { useLanguage } from '@/contexts/LanguageContext';
import { formatMoney } from '@/lib/format';
import type { OrderDetail } from '@/lib/orders';

interface SummaryCardProps {
  order: OrderDetail;
}

/**
 * Order totals card — mirrors the admin SummaryCard. Subtotal, discount (with
 * percent), tax, delivery fee, and the bold total. Zero-value rows are muted
 * rather than hidden so the breakdown is always complete.
 */
export function SummaryCard({ order }: SummaryCardProps) {
  const { t } = useLanguage();
  const discountPct = order.subtotal > 0 ? Math.round((order.discount / order.subtotal) * 100) : 0;

  const rows: Array<{ label: string; value: string; muted?: boolean }> = [
    { label: t.detail.subtotal, value: formatMoney(order.subtotal, order.currency) },
    {
      label: t.detail.discount,
      value: `${formatMoney(order.discount, order.currency)} (${discountPct}%)`,
      muted: order.discount === 0,
    },
    { label: t.detail.tax, value: formatMoney(order.tax, order.currency), muted: order.tax === 0 },
    {
      label: t.detail.deliveryFee,
      value: formatMoney(order.shipping, order.currency),
      muted: order.shipping === 0,
    },
  ];

  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted-foreground">
        {t.detail.summary}
      </h2>
      <dl className="space-y-2.5 text-sm">
        {rows.map(row => (
          <div key={row.label} className="flex items-center justify-between">
            <dt className={row.muted ? 'text-muted-foreground' : 'text-foreground'}>{row.label}</dt>
            <dd
              className={`font-medium ${row.muted ? 'text-muted-foreground' : 'text-foreground'}`}
            >
              {row.value}
            </dd>
          </div>
        ))}
        <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
          <dt className="font-semibold text-foreground">{t.detail.total}</dt>
          <dd className="text-base font-semibold text-foreground">
            {formatMoney(order.total, order.currency)}
          </dd>
        </div>
      </dl>
    </section>
  );
}
