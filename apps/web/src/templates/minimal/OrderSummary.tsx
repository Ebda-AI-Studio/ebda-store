'use client';

import Link from 'next/link';
import type { OrderSummaryProps } from '../types';
import { useOrderSummaryBase } from '../shared/useOrderSummaryBase';

export default function MinimalOrderSummary({
  subtotal,
  discount = 0,
  discountLabel,
  shipping = 0,
  freeShipping = false,
  shippingPending = false,
  tax = 0,
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
  const { isRtl, fmt, ctaText, summaryLabelBold, labelColorStyle, totalColorStyle } =
    useOrderSummaryBase({ currency, ctaLabel, ctaLabelAr, summaryColors, isRtl: isRtlProp });

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
          <div className="flex items-center justify-between text-success">
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
          <dd className="text-foreground tabular-nums" style={typography?.price}>
            {shippingPending ? (
              <span className="text-muted-foreground">
                {isRtl ? 'يحسب عند الدفع' : 'Calculated at checkout'}
              </span>
            ) : freeShipping ? (
              <span className="text-success">{isRtl ? 'مجاني' : 'Free'}</span>
            ) : (
              fmt(shipping)
            )}
          </dd>
        </div>
        {tax > 0 && (
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground" style={typography?.label}>
              {isRtl ? 'الضريبة' : 'Tax'}
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
      {children && <div className="mt-6">{children}</div>}
      {ctaDisabled && ctaBlockedMessage && (
        <p className="mt-6 text-xs font-light text-warning">{ctaBlockedMessage}</p>
      )}
      {ctaText &&
        (ctaHref && !ctaDisabled ? (
          <Link
            href={ctaHref}
            data-cta="link"
            className="mt-8 block border-b border-foreground pb-1 text-sm text-foreground hover:border-primary hover:text-primary transition-colors duration-500 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground"
            style={typography?.cta}
          >
            {ctaText} {isRtl ? '←' : '→'}
          </Link>
        ) : (
          <button
            type="button"
            onClick={onCtaClick}
            disabled={ctaDisabled || ctaLoading}
            data-cta="link"
            className="mt-8 block w-fit border-b border-foreground pb-1 text-sm text-foreground hover:border-primary hover:text-primary transition-colors duration-500 ease-out disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground"
            style={typography?.cta}
          >
            {ctaLoading ? '···' : `${ctaText} ${isRtl ? '←' : '→'}`}
          </button>
        ))}
    </aside>
  );
}
