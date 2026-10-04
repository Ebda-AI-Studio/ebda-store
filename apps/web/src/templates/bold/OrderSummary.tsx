'use client';

import Link from 'next/link';
import type { OrderSummaryProps } from '../types';
import { useOrderSummaryBase } from '../shared/useOrderSummaryBase';

import { REGION } from '@force/shared';
export default function BoldOrderSummary({
  subtotal,
  discount = 0,
  discountLabel,
  shipping = 0,
  freeShipping = false,
  shippingPending = false,
  tax = 0,
  taxRatePercent = 0,
  taxIncludedInPrice = false,
  total,
  currency = REGION.currency,
  isRtl: isRtlProp,
  children,
  ctaLabel,
  ctaLabelAr,
  ctaHref,
  onCtaClick,
  ctaDisabled,
  ctaLoading,
  ctaBlockedMessage,
  typography,
  summaryColors,
}: OrderSummaryProps) {
  const { isRtl, fmt, ctaText, summaryLabelBold, labelColorStyle, totalColorStyle, taxLabel } =
    useOrderSummaryBase({
      currency,
      ctaLabel,
      ctaLabelAr,
      summaryColors,
      isRtl: isRtlProp,
      tax,
      taxRatePercent,
      taxIncludedInPrice,
    });

  return (
    <aside
      dir={isRtl ? 'rtl' : 'ltr'}
      className="border-2 border-foreground bg-background"
      aria-label={isRtl ? 'ملخص الطلب' : 'Order summary'}
    >
      <h2
        className="border-b-2 border-foreground bg-foreground px-5 py-3 text-sm font-black uppercase tracking-widest text-background"
        style={{ ...typography?.heading, ...labelColorStyle }}
      >
        {isRtl ? 'ملخص الطلب' : 'Order Summary'}
      </h2>
      <dl className="space-y-3 p-5 text-sm" aria-live="polite">
        <div className="flex items-center justify-between">
          <dt
            className={`${summaryLabelBold ? 'font-bold' : 'font-normal'} uppercase tracking-wider text-muted-foreground`}
            style={{ ...typography?.label, ...labelColorStyle }}
          >
            {isRtl ? 'المجموع الفرعي' : 'Subtotal'}
          </dt>
          <dd className="font-black text-foreground tabular-nums" style={typography?.price}>
            {fmt(subtotal)}
          </dd>
        </div>
        {discount > 0 && (
          <div className="flex items-center justify-between text-success-ink">
            <dt className="font-bold uppercase tracking-wider" style={typography?.label}>
              {discountLabel ?? (isRtl ? 'الخصم' : 'Discount')}
            </dt>
            <dd className="font-black tabular-nums" style={typography?.price}>
              −{fmt(discount)}
            </dd>
          </div>
        )}
        <div className="flex items-center justify-between">
          <dt
            className={`${summaryLabelBold ? 'font-bold' : 'font-normal'} uppercase tracking-wider text-muted-foreground`}
            style={{ ...typography?.label, ...labelColorStyle }}
          >
            {isRtl ? 'الشحن' : 'Shipping'}
          </dt>
          <dd className="font-black text-foreground tabular-nums" style={typography?.price}>
            {shippingPending ? (
              <span className="text-muted-foreground">
                {isRtl ? 'يحسب عند الدفع' : 'Calculated at checkout'}
              </span>
            ) : freeShipping ? (
              <span className="text-success-ink">{isRtl ? 'مجاني' : 'FREE'}</span>
            ) : (
              fmt(shipping)
            )}
          </dd>
        </div>
        {tax > 0 && !taxIncludedInPrice && (
          <div className="flex items-center justify-between">
            <dt
              className="font-bold uppercase tracking-wider text-muted-foreground"
              style={typography?.label}
            >
              {taxLabel}
            </dt>
            <dd className="font-black text-foreground tabular-nums" style={typography?.price}>
              {fmt(tax)}
            </dd>
          </div>
        )}
        <div className="mt-3 flex items-baseline justify-between border-t-2 border-foreground pt-3">
          <dt
            className={`text-base ${summaryLabelBold ? 'font-black' : 'font-normal'} uppercase tracking-tight text-foreground`}
            style={{ ...typography?.heading, ...totalColorStyle }}
          >
            {isRtl ? 'الإجمالي' : 'Total'}
          </dt>
          <dd
            className="text-2xl font-black tracking-tight text-foreground tabular-nums"
            style={{ ...typography?.price, ...totalColorStyle }}
          >
            {fmt(total)}
          </dd>
        </div>
      </dl>
      {tax > 0 && taxIncludedInPrice && (
        <p className="px-5 pt-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
          {taxLabel} {'\u2014'} {fmt(tax)}
        </p>
      )}
      {children && <div className="border-t-2 border-foreground p-5">{children}</div>}
      {ctaDisabled && ctaBlockedMessage && (
        <p className="border-t-2 border-warning bg-warning/10 px-5 py-3 text-xs font-bold uppercase tracking-wide text-warning-ink">
          {ctaBlockedMessage}
        </p>
      )}
      {ctaText && (
        <div className="border-t-2 border-foreground">
          {ctaHref && !ctaDisabled ? (
            <Link
              href={ctaHref}
              data-cta="button"
              className="flex h-14 w-full items-center justify-center bg-primary px-5 text-sm font-black uppercase tracking-[0.18em] text-primary-foreground hover:bg-primary/90 transition-colors duration-200 ease-out focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2"
              style={typography?.cta}
            >
              {ctaText} {isRtl ? '←' : '→'}
            </Link>
          ) : (
            <button
              type="button"
              onClick={onCtaClick}
              disabled={ctaDisabled || ctaLoading}
              data-cta="button"
              className="flex h-14 w-full items-center justify-center bg-primary px-5 text-sm font-black uppercase tracking-[0.18em] text-primary-foreground hover:bg-primary/90 transition-colors duration-200 ease-out disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2"
              style={typography?.cta}
            >
              {ctaLoading ? '···' : `${ctaText} ${isRtl ? '←' : '→'}`}
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
