'use client';

import Link from 'next/link';
import type { OrderSummaryProps } from '../types';
import { useOrderSummaryBase } from '../shared/useOrderSummaryBase';

export default function ClassicOrderSummary({
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
  currency = 'KWD',
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
      className="border border-border bg-background p-6"
      aria-label={isRtl ? 'ملخص الطلب' : 'Order summary'}
    >
      <h2
        className="text-sm font-bold uppercase tracking-widest text-muted-foreground"
        style={{ ...typography?.heading, ...labelColorStyle }}
      >
        {isRtl ? 'ملخص الطلب' : 'Order Summary'}
      </h2>
      <dl className="mt-6 space-y-4 text-sm" aria-live="polite">
        <div className="flex items-center justify-between">
          <dt
            className={`${summaryLabelBold ? 'font-semibold' : 'font-normal'} text-muted-foreground`}
            style={{ ...typography?.label, ...labelColorStyle }}
          >
            {isRtl ? 'المجموع الفرعي' : 'Subtotal'}
          </dt>
          <dd className="tracking-tight text-foreground tabular-nums" style={typography?.price}>
            {fmt(subtotal)}
          </dd>
        </div>
        {discount > 0 && (
          <div className="flex items-center justify-between text-success-ink">
            <dt style={typography?.label}>{discountLabel ?? (isRtl ? 'الخصم' : 'Discount')}</dt>
            <dd className="tabular-nums" style={typography?.price}>
              −{fmt(discount)}
            </dd>
          </div>
        )}
        <div className="flex items-center justify-between">
          <dt
            className={`${summaryLabelBold ? 'font-semibold' : 'font-normal'} text-muted-foreground`}
            style={{ ...typography?.label, ...labelColorStyle }}
          >
            {isRtl ? 'الشحن' : 'Shipping'}
          </dt>
          <dd className="tracking-tight text-foreground tabular-nums" style={typography?.price}>
            {shippingPending ? (
              <span className="text-muted-foreground">
                {isRtl ? 'يحسب عند الدفع' : 'Calculated at checkout'}
              </span>
            ) : freeShipping ? (
              <span className="text-success-ink uppercase text-xs">{isRtl ? 'مجاني' : 'Free'}</span>
            ) : (
              fmt(shipping)
            )}
          </dd>
        </div>
        {tax > 0 && !taxIncludedInPrice && (
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground" style={typography?.label}>
              {taxLabel}
            </dt>
            <dd className="tracking-tight text-foreground tabular-nums" style={typography?.price}>
              {fmt(tax)}
            </dd>
          </div>
        )}
        <div className="mt-6 flex items-baseline justify-between border-t border-border pt-6">
          <dt
            className={`text-sm ${summaryLabelBold ? 'font-bold' : 'font-normal'} uppercase tracking-widest text-foreground`}
            style={{ ...typography?.heading, ...totalColorStyle }}
          >
            {isRtl ? 'الإجمالي' : 'Total'}
          </dt>
          <dd
            className="text-lg font-semibold tracking-tight text-foreground tabular-nums"
            style={{ ...typography?.price, ...totalColorStyle }}
          >
            {fmt(total)}
          </dd>
        </div>
      </dl>
      {tax > 0 && taxIncludedInPrice && (
        <p className="mt-2 text-xs text-muted-foreground">
          {taxLabel} {'\u2014'} {fmt(tax)}
        </p>
      )}
      {children && <div className="mt-6">{children}</div>}
      {ctaDisabled && ctaBlockedMessage && (
        <p className="mt-4 border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning-ink">
          {ctaBlockedMessage}
        </p>
      )}
      {ctaText &&
        (ctaHref && !ctaDisabled ? (
          <Link
            href={ctaHref}
            data-cta="button"
            className="mt-6 flex h-12 w-full items-center justify-center border border-foreground bg-foreground px-4 text-xs font-serif font-semibold uppercase tracking-[0.22em] text-background hover:bg-foreground/85 transition-colors duration-500 ease-out focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2"
            style={typography?.cta}
          >
            {ctaText}
          </Link>
        ) : (
          <button
            type="button"
            onClick={onCtaClick}
            disabled={ctaDisabled || ctaLoading}
            data-cta="button"
            className="mt-6 flex h-12 w-full items-center justify-center border border-foreground bg-foreground px-4 text-xs font-serif font-semibold uppercase tracking-[0.22em] text-background hover:bg-foreground/85 disabled:opacity-50 transition-colors duration-500 ease-out focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2"
            style={typography?.cta}
          >
            {ctaLoading ? (isRtl ? 'جارٍ...' : 'Processing...') : ctaText}
          </button>
        ))}
    </aside>
  );
}
