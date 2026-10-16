'use client';

import Link from 'next/link';
import { MINUS, SignedAmount } from '@/lib/bidi';
import type { OrderSummaryProps } from '../types';
import { useOrderSummaryBase } from '../shared/useOrderSummaryBase';
import { ArrowIcon } from '../shared/icons';

import { REGION } from '@ebda/shared';
export default function ModernOrderSummary({
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
      className="rounded-2xl border border-border/60 bg-card p-7 shadow-[0_18px_36px_-22px_hsl(var(--foreground)/0.10)]"
      aria-label={isRtl ? 'ملخص الطلب' : 'Order summary'}
    >
      <h2
        className="text-lg font-bold text-foreground tracking-tight"
        style={{ ...typography?.heading, ...labelColorStyle }}
      >
        {isRtl ? 'ملخص الطلب' : 'Order Summary'}
      </h2>
      <dl className="mt-5 space-y-3 text-sm" aria-live="polite">
        <div className="flex items-center justify-between">
          <dt
            className={`${summaryLabelBold ? 'font-semibold' : 'font-normal'} text-muted-foreground`}
            style={{ ...typography?.label, ...labelColorStyle }}
          >
            {isRtl ? 'المجموع الفرعي' : 'Subtotal'}
          </dt>
          <dd className="font-medium text-foreground tabular-nums" style={typography?.price}>
            {fmt(subtotal)}
          </dd>
        </div>
        {discount > 0 && (
          <div className="flex items-center justify-between text-success-ink">
            <dt style={typography?.label}>{discountLabel ?? (isRtl ? 'الخصم' : 'Discount')}</dt>
            <dd className="font-medium tabular-nums" style={typography?.price}>
              <SignedAmount sign={MINUS} value={fmt(discount)} />
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
          <dd className="font-medium text-foreground tabular-nums" style={typography?.price}>
            {shippingPending ? (
              <span className="text-muted-foreground">
                {isRtl ? 'يحسب عند الدفع' : 'Calculated at checkout'}
              </span>
            ) : freeShipping ? (
              <span className="text-success-ink">{isRtl ? 'مجاني' : 'Free'}</span>
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
            <dd className="font-medium text-foreground tabular-nums" style={typography?.price}>
              {fmt(tax)}
            </dd>
          </div>
        )}
        <div className="mt-4 flex items-baseline justify-between border-t border-border/60 pt-4">
          <dt
            className={`text-base ${summaryLabelBold ? 'font-bold' : 'font-normal'} text-foreground`}
            style={{ ...typography?.heading, ...totalColorStyle }}
          >
            {isRtl ? 'الإجمالي' : 'Total'}
          </dt>
          <dd
            className={`text-xl ${summaryLabelBold ? 'font-bold' : 'font-normal'} text-primary tabular-nums`}
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
      {children && <div className="mt-5">{children}</div>}
      {ctaDisabled && ctaBlockedMessage && (
        <p className="mt-4 rounded-lg bg-warning/10 px-3 py-2 text-xs font-medium text-warning-ink">
          {ctaBlockedMessage}
        </p>
      )}
      {ctaText &&
        (ctaHref && !ctaDisabled ? (
          <Link
            href={ctaHref}
            data-cta="button"
            className="mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold tracking-tight text-primary-foreground transition-colors duration-300 ease-out hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
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
            className="mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold tracking-tight text-primary-foreground transition-colors duration-300 ease-out hover:bg-primary/90 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            style={typography?.cta}
          >
            {ctaLoading ? (
              <span
                className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent"
                aria-hidden
              />
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
