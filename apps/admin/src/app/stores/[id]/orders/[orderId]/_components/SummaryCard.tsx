'use client';

import { useT } from '@/i18n/useT';
import { formatMoney } from './format';
import type { OrderDetail } from './types';

interface SummaryCardProps {
  order: OrderDetail;
}

export function SummaryCard({ order }: SummaryCardProps) {
  const t = useT('orders.detail');
  const discountPct = order.subtotal > 0 ? Math.round((order.discount / order.subtotal) * 100) : 0;

  const rows: Array<{ label: string; value: string; muted?: boolean }> = [
    { label: t('subtotal'), value: formatMoney(order.subtotal, order.currency) },
    {
      label: t('discount'),
      value: `${formatMoney(order.discount, order.currency)} (${discountPct}%)`,
      muted: order.discount === 0,
    },
    { label: t('tax'), value: formatMoney(order.tax, order.currency), muted: order.tax === 0 },
    {
      label: t('deliveryFee'),
      value: formatMoney(order.shipping, order.currency),
      muted: order.shipping === 0,
    },
  ];

  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-4">
        {t('summary')}
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
        <div className="border-t border-border pt-3 mt-3 flex items-center justify-between">
          <dt className="font-semibold text-foreground">{t('total')}</dt>
          <dd className="font-semibold text-foreground text-base">
            {formatMoney(order.total, order.currency)}
          </dd>
        </div>
      </dl>
    </section>
  );
}
