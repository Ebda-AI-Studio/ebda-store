'use client';

import { orderTaxPlacement, withNumerals, formatSigned } from '@ebda/shared';
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
  const taxPlacement = orderTaxPlacement(order);

  // Break the total discount into its levers — coupon, automatic promotion,
  // loyalty-points redemption, and any remainder — instead of one aggregate
  // line, so the fulfillment operator can see WHAT discounted the order.
  // couponDiscount + promotionDiscount + loyaltyDiscount + "other" always
  // reconciles to `discount` (see order.service.ts's create()). Loyalty split
  // out in step with the admin SummaryCard and the storefront order detail
  // (issue 197): all three surfaces must name the same levers for one order.
  const couponPortion = order.couponDiscount ?? 0;
  const promotionPortion = order.promotionDiscount ?? 0;
  const loyaltyPortion = order.loyaltyDiscount ?? 0;
  const otherDiscount = Math.max(
    0,
    order.discount - couponPortion - promotionPortion - loyaltyPortion
  );
  // The percentage of the amount SHOWN on the remainder row — the whole-order
  // `discount / subtotal` printed next to only the remainder labelled e.g.
  // 0.500 EGP as "50%" once coupon/promotion/loyalty were split out (#2261).
  const otherDiscountPct =
    order.subtotal > 0 ? Math.round((otherDiscount / order.subtotal) * 100) : 0;
  const walletAmount = order.walletAmount ?? 0;
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
    ...(loyaltyPortion > 0
      ? [
          {
            label: `${t.detail.loyaltyPoints}${order.loyaltyPointsRedeemed ? ` (${order.loyaltyPointsRedeemed.toLocaleString(locale, withNumerals())})` : ''}`,
            value: formatMoney(loyaltyPortion, order.currency),
          },
        ]
      : []),
    ...(otherDiscount > 0
      ? [
          {
            label: t.detail.discount,
            value: `${formatMoney(otherDiscount, order.currency)} (${otherDiscountPct}%)`,
          },
        ]
      : []),
    ...(order.discount === 0
      ? [{ label: t.detail.discount, value: `${formatMoney(0, order.currency)} (0%)`, muted: true }]
      : []),
    {
      label: t.detail.deliveryFee,
      value: formatMoney(order.shipping, order.currency),
      muted: order.shipping === 0,
    },
    // Cash-on-delivery fee: its own row, before VAT (rulings MONEYB-2/3).
    ...((order.codFee ?? 0) > 0
      ? [
          {
            label: t.detail.codFee,
            value: formatMoney(order.codFee ?? 0, order.currency),
            muted: false,
          },
        ]
      : []),
    // Exclusive tax is a summed row; inclusive tax is already inside
    // subtotal/total and is captioned after Total instead (issue 2210).
    ...(taxPlacement.taxRow !== null
      ? [
          {
            label: t.detail.tax,
            value: formatMoney(taxPlacement.taxRow, order.currency),
            muted: taxPlacement.taxRow === 0,
          },
        ]
      : []),
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
        {taxPlacement.includedTaxCaption !== null && (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <dt>{t.detail.taxIncluded}</dt>
            <dd>{formatMoney(taxPlacement.includedTaxCaption, order.currency)}</dd>
          </div>
        )}
        {/* Customer wallet (D1): what the courier collects on a COD order is
            the amount due, not the total, when part was paid from store credit. */}
        {walletAmount > 0 && (
          <>
            <div className="flex items-center justify-between">
              <dt className="text-foreground">{t.detail.paidFromWallet}</dt>
              <dd className="font-medium text-foreground">
                {formatSigned(-walletAmount, { format: abs => formatMoney(abs, order.currency) })}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="font-semibold text-foreground">{t.detail.amountDue}</dt>
              <dd className="font-semibold text-foreground">
                {formatMoney(Math.max(0, order.total - walletAmount), order.currency)}
              </dd>
            </div>
          </>
        )}
      </dl>
    </section>
  );
}
