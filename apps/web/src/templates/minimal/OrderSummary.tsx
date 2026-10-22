'use client';

import Link from 'next/link';
import { MINUS, SignedAmount } from '@/lib/bidi';
import type { OrderSummaryProps } from '../types';
import { useOrderSummaryBase } from '../shared/useOrderSummaryBase';
import { ArrowIcon } from '../shared/icons';

import { REGION } from '@ebda/shared';
export default function MinimalOrderSummary({
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
    <aside dir={isRtl ? 'rtl' : 'ltr'} aria-label={isRtl ? 'ملخص الطلب' : 'Order summary'}>
      <dl className="space-y-4 text-sm" aria-live="polite">
        <div className="flex items-center justify-between">
          <dt
            className={`${summaryLabelBold ? 'font-semibold' : 'font-normal'} text-muted-foreground`}
            style={{ ...typography?.label, ...labelColorStyle }}
          >
            {isRtl ? 'المجموع الفرعي' : 'Subtotal'}
          </dt>
          <dd className="text-foreground tabular-nums" style={typography?.price}>
            {fmt(subtotal)}
          </dd>
        </div>
        {discount > 0 && (
          <div className="flex items-center justify-between text-success-ink">
            <dt style={typography?.label}>{discountLabel ?? (isRtl ? 'الخصم' : 'Discount')}</dt>
            <dd className="tabular-nums" style={typography?.price}>
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
          <dd className="text-foreground tabular-nums" style={typography?.price}>
            {shippingPending ? (
              <span className="text-muted-foreground">
                {isRtl ? 'بيتحسب عند الدفع' : 'Calculated at checkout'}
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
            <dd className="text-foreground tabular-nums" style={typography?.price}>
              {fmt(tax)}
            </dd>
          </div>
        )}
        <div className="flex items-baseline justify-between border-t border-border pt-5">
          <dt
            className={`${summaryLabelBold ? 'font-bold' : 'font-normal'} text-foreground`}
            style={{ ...typography?.heading, ...totalColorStyle }}
          >
            {isRtl ? 'الإجمالي' : 'Total'}
          </dt>
          <dd
            className="text-lg text-foreground tabular-nums"
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
        <p className="mt-6 text-xs font-light text-warning-ink">{ctaBlockedMessage}</p>
      )}
      {ctaText &&
        (ctaHref && !ctaDisabled ? (
          <Link
            href={ctaHref}
            data-cta="button"
            className="mt-8 flex h-12 w-full items-center justify-center gap-2 rounded-[var(--radius)] bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors duration-200 ease-out hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground"
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
            className="mt-8 flex h-12 w-full items-center justify-center gap-2 rounded-[var(--radius)] bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors duration-200 ease-out hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground disabled:opacity-40"
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
