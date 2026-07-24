'use client';

import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import { formatMoney } from './format';
import type { OrderDetail } from './types';

interface SummaryCardProps {
  order: OrderDetail;
}

export function SummaryCard({ order }: SummaryCardProps) {
  const t = useT('orders.detail');
  const locale = useLocale();
  const discountPct = order.subtotal > 0 ? Math.round((order.discount / order.subtotal) * 100) : 0;

  // Break the total discount into its levers — coupon, automatic promotion,
  // and everything else (loyalty redemption etc.) — instead of showing the
  // aggregate `discount` line alongside a coupon-only sub-line, which used to
  // double-count the coupon portion visually. couponDiscount + promotionDiscount
  // + "other" always reconciles to `discount` (see order.service.ts's create()).
  const couponPortion = order.couponDiscount ?? 0;
  const promotionPortion = order.promotionDiscount ?? 0;
  const otherDiscount = Math.max(0, order.discount - couponPortion - promotionPortion);
  const promotionName = order.appliedPromotion
    ? locale === 'ar' && order.appliedPromotion.nameAr
      ? order.appliedPromotion.nameAr
      : order.appliedPromotion.name
    : null;

  const rows: Array<{ label: string; value: string; muted?: boolean }> = [
    { label: t('subtotal'), value: formatMoney(order.subtotal, order.currency) },
    ...(couponPortion > 0
      ? [
          {
            label: `${t('coupon')}${order.couponCode ? ` (${order.couponCode})` : ''}`,
            value: formatMoney(couponPortion, order.currency),
          },
        ]
      : []),
    ...(promotionPortion > 0
      ? [
          {
            label: `${t('promotion')}${promotionName ? ` (${promotionName})` : ''}`,
            value: formatMoney(promotionPortion, order.currency),
          },
        ]
      : []),
    ...(otherDiscount > 0
      ? [
          {
            label: t('discount'),
            value: `${formatMoney(otherDiscount, order.currency)} (${discountPct}%)`,
          },
        ]
      : []),
    ...(order.discount === 0
      ? [{ label: t('discount'), value: `${formatMoney(0, order.currency)} (0%)`, muted: true }]
      : []),
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
        {rows.map((row, idx) => (
          <div key={`${row.label}-${idx}`} className="flex items-center justify-between">
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
