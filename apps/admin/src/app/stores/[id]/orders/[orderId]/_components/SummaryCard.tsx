'use client';

import { useLocale } from 'next-intl';
import { useT } from '@/i18n/useT';
import { orderTaxPlacement } from '@ebda/shared';
import { formatMoney } from './format';
import type { OrderDetail } from './types';

interface SummaryCardProps {
  order: OrderDetail;
}

export function SummaryCard({ order }: SummaryCardProps) {
  const t = useT('orders.detail');
  const locale = useLocale();
  const taxPlacement = orderTaxPlacement(order);

  // Break the total discount into its levers — coupon, automatic promotion,
  // loyalty-points redemption, and any remainder — instead of showing the
  // aggregate `discount` line alongside a coupon-only sub-line, which used to
  // double-count the coupon portion visually. couponDiscount + promotionDiscount
  // + loyaltyDiscount + "other" always reconciles to `discount` (see
  // order.service.ts's create()). Loyalty split out (#197): docs/uat/
  // loyalty-redemption.md step 11 requires the order detail to show it
  // distinctly, not folded into a generic "Discount" line.
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
  // I5 (final review): reporting-only, NOT a component of `discount` — the
  // saving already lives in a lower `subtotal` (a bundle is priced at
  // bundlePrice, never componentSum), so it is shown as its own informational
  // line and never subtracted from anything here.
  const bundleSavings = order.bundleDiscount ?? 0;
  const walletAmount = order.walletAmount ?? 0;
  const promotionName = order.appliedPromotion
    ? locale === 'ar' && order.appliedPromotion.nameAr
      ? order.appliedPromotion.nameAr
      : order.appliedPromotion.name
    : null;

  const rows: Array<{ label: string; value: string; muted?: boolean }> = [
    { label: t('subtotal'), value: formatMoney(order.subtotal, order.currency) },
    ...(order.priceGroupName
      ? [{ label: t('priceGroup'), value: order.priceGroupName, muted: true }]
      : []),
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
    ...(loyaltyPortion > 0
      ? [
          {
            label: `${t('loyaltyPoints')}${order.loyaltyPointsRedeemed ? ` (${order.loyaltyPointsRedeemed.toLocaleString(locale, { numberingSystem: 'latn' })})` : ''}`,
            value: formatMoney(loyaltyPortion, order.currency),
          },
        ]
      : []),
    ...(otherDiscount > 0
      ? [
          {
            label: t('discount'),
            value: `${formatMoney(otherDiscount, order.currency)} (${otherDiscountPct}%)`,
          },
        ]
      : []),
    ...(order.discount === 0
      ? [{ label: t('discount'), value: `${formatMoney(0, order.currency)} (0%)`, muted: true }]
      : []),
    ...(bundleSavings > 0
      ? [
          {
            label: t('bundleSavings'),
            value: formatMoney(bundleSavings, order.currency),
            muted: true,
          },
        ]
      : []),
    {
      label: t('deliveryFee'),
      value: formatMoney(order.shipping, order.currency),
      muted: order.shipping === 0,
    },
    // Cash-on-delivery fee: its own row, before VAT (rulings MONEYB-2/3).
    ...((order.codFee ?? 0) > 0
      ? [
          {
            label: t('codFee'),
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
            label: t('tax'),
            value: formatMoney(taxPlacement.taxRow, order.currency),
            muted: taxPlacement.taxRow === 0,
          },
        ]
      : []),
  ];

  return (
    <section className="rounded-lg border border-border bg-card p-5">
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
        {taxPlacement.includedTaxCaption !== null && (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <dt>{t('taxIncluded')}</dt>
            <dd>{formatMoney(taxPlacement.includedTaxCaption, order.currency)}</dd>
          </div>
        )}
        {/* Customer wallet (D1): the part of the total the customer paid from
            store credit, and what the gateway / courier actually collects. */}
        {walletAmount > 0 && (
          <>
            <div className="flex items-center justify-between">
              <dt className="text-foreground">{t('paidFromWallet')}</dt>
              <dd className="font-medium text-foreground">
                −{formatMoney(walletAmount, order.currency)}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="font-semibold text-foreground">{t('amountDue')}</dt>
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
