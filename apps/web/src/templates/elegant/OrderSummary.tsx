'use client';

import Link from 'next/link';
import { MINUS, SignedAmount } from '@/lib/bidi';
import type { OrderSummaryProps } from '../types';
import { useOrderSummaryBase } from '../shared/useOrderSummaryBase';
import { ArrowIcon } from '../shared/icons';

import { REGION } from '@ebda/shared';
export default function ElegantOrderSummary({
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
      className="border-t border-foreground/20 pt-8"
      aria-label={isRtl ? 'ملخص الطلب' : 'Order summary'}
    >
      <h2
        className="text-sm font-bold uppercase tracking-[0.3em] text-muted-foreground"
        style={{ ...typography?.heading, ...labelColorStyle }}
      >
        {isRtl ? 'ملخص الطلب' : 'Order Summary'}
      </h2>
      <dl className="mt-8 space-y-5 text-sm font-light" aria-live="polite">
        <div className="flex items-center justify-between">
          <dt
            className={`${summaryLabelBold ? 'font-semibold' : 'font-normal'} tracking-wide text-muted-foreground`}
            style={{ ...typography?.label, ...labelColorStyle }}
          >
            {isRtl ? 'المجموع الفرعي' : 'Subtotal'}
          </dt>
          <dd className="tracking-wide text-foreground tabular-nums" style={typography?.price}>
            {fmt(subtotal)}
          </dd>
        </div>
        {discount > 0 && (
          <div className="flex items-center justify-between text-success-ink">
            <dt className="tracking-wide" style={typography?.label}>
              {discountLabel ?? (isRtl ? 'الخصم' : 'Discount')}
            </dt>
            <dd className="tracking-wide tabular-nums" style={typography?.price}>
              <SignedAmount sign={MINUS} value={fmt(discount)} />
            </dd>
          </div>
        )}
        <div className="flex items-center justify-between">
          <dt
            className={`${summaryLabelBold ? 'font-semibold' : 'font-normal'} tracking-wide text-muted-foreground`}
            style={{ ...typography?.label, ...labelColorStyle }}
          >
            {isRtl ? 'الشحن' : 'Shipping'}
          </dt>
          <dd className="tracking-wide text-foreground tabular-nums" style={typography?.price}>
            {shippingPending ? (
              <span className="text-muted-foreground">
                {isRtl ? 'بيتحسب عند الدفع' : 'Calculated at checkout'}
              </span>
            ) : freeShipping ? (
              <span className="text-success-ink uppercase tracking-[0.2em] text-xs">
                {isRtl ? 'مجاني' : 'Complimentary'}
              </span>
            ) : (
              fmt(shipping)
            )}
          </dd>
        </div>
        {tax > 0 && !taxIncludedInPrice && (
          <div className="flex items-center justify-between">
            <dt className="tracking-wide text-muted-foreground" style={typography?.label}>
              {taxLabel}
            </dt>
            <dd className="tracking-wide text-foreground tabular-nums" style={typography?.price}>
              {fmt(tax)}
            </dd>
          </div>
        )}
        <div className="mt-8 flex items-baseline justify-between border-t border-foreground/20 pt-8">
          <dt
            className={`text-sm ${summaryLabelBold ? 'font-bold' : 'font-normal'} uppercase tracking-[0.3em] text-foreground`}
            style={{ ...typography?.heading, ...totalColorStyle }}
          >
            {isRtl ? 'الإجمالي' : 'Total'}
          </dt>
          <dd
            className="text-xl font-light tracking-wide text-foreground tabular-nums"
            style={{ ...typography?.price, ...totalColorStyle }}
          >
            {fmt(total)}
          </dd>
        </div>
      </dl>
      {tax > 0 && taxIncludedInPrice && (
        <p className="mt-3 text-xs tracking-wide text-muted-foreground">
          {taxLabel} {'\u2014'} {fmt(tax)}
        </p>
      )}
      {children && <div className="mt-8">{children}</div>}
      {ctaDisabled && ctaBlockedMessage && (
        <p className="mt-6 border border-warning/30 bg-warning/10 px-3 py-2 text-xs font-light tracking-wide text-warning-ink">
          {ctaBlockedMessage}
        </p>
      )}
      {ctaText &&
        (ctaHref && !ctaDisabled ? (
          <Link
            href={ctaHref}
            data-cta="button"
            className="mt-8 flex h-12 w-full items-center justify-center gap-2 border border-foreground bg-foreground px-4 text-xs font-medium uppercase tracking-[0.3em] text-background hover:bg-foreground/85 transition-colors duration-700 ease-out focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2"
            style={typography?.cta}
          >
            {ctaText}
            <ArrowIcon className="h-4 w-4 shrink-0" isRtl={isRtl} />
          </Link>
        ) : (
          <button
            type="button"
            onClick={onCtaClick}
            disabled={ctaDisabled || ctaLoading}
            data-cta="button"
            className="mt-8 flex h-12 w-full items-center justify-center gap-2 border border-foreground bg-foreground px-4 text-xs font-medium uppercase tracking-[0.3em] text-background hover:bg-foreground/85 disabled:opacity-40 transition-colors duration-700 ease-out focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2"
            style={typography?.cta}
          >
            {ctaLoading ? (
              '···'
            ) : (
              <>
                {ctaText}
                <ArrowIcon className="h-4 w-4 shrink-0" isRtl={isRtl} />
              </>
            )}
          </button>
        ))}
    </aside>
  );
}
