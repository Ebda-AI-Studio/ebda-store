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
  const { t, locale } = useLanguage();
  const discountPct = order.subtotal > 0 ? Math.round((order.discount / order.subtotal) * 100) : 0;

  // Break the total discount into its levers — coupon, automatic promotion,
  // and everything else (loyalty redemption etc.) — instead of one aggregate
  // line, so the fulfillment operator can see WHAT discounted the order.
  // couponDiscount + promotionDiscount + "other" always reconciles to
  // `discount` (see order.service.ts's create()).
  const couponPortion = order.couponDiscount ?? 0;
  const promotionPortion = order.promotionDiscount ?? 0;
  const otherDiscount = Math.max(0, order.discount - couponPortion - promotionPortion);
  const promotionName = order.appliedPromotion
    ? locale === 'ar' && order.appliedPromotion.nameAr
      ? order.appliedPromotion.nameAr
      : order.appliedPromotion.name
    : null;

  const rows: Array<{ label: string; value: string; muted?: boolean }> = [
    { label: t.detail.subtotal, value: formatMoney(order.subtotal, order.currency) },
    ...(couponPortion > 0
      ? [
          {
            label: `${t.detail.coupon}${order.couponCode ? ` (${order.couponCode})` : ''}`,
            value: formatMoney(couponPortion, order.currency),
          },
        ]
      : []),
    ...(promotionPortion > 0
      ? [
          {
            label: `${t.detail.promotion}${promotionName ? ` (${promotionName})` : ''}`,
            value: formatMoney(promotionPortion, order.currency),
          },
        ]
      : []),
    ...(otherDiscount > 0
      ? [
          {
            label: t.detail.discount,
            value: `${formatMoney(otherDiscount, order.currency)} (${discountPct}%)`,
          },
        ]
      : []),
    ...(order.discount === 0
      ? [{ label: t.detail.discount, value: `${formatMoney(0, order.currency)} (0%)`, muted: true }]
      : []),
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
