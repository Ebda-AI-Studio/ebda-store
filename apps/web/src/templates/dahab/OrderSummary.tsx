'use client';

import Link from 'next/link';
import { MINUS, SignedAmount } from '@/lib/bidi';
import type { OrderSummaryProps } from '../types';
import { useOrderSummaryBase } from '../shared/useOrderSummaryBase';
import { ArrowIcon } from '../shared/icons';
import { useLocalePrice } from '../../hooks/useLocalePrice';
import { DahabPaymentMarks } from './Footer';
import { DAHAB_BTN_PRIMARY, cx } from './ui';
import { REGION } from '@ebda/shared';

export default function DahabOrderSummary({
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
  const { isRtl, ctaText, labelColorStyle, totalColorStyle, taxLabel } = useOrderSummaryBase({
    currency,
    ctaLabel,
    ctaLabelAr,
    summaryColors,
    isRtl: isRtlProp,
    tax,
    taxRatePercent,
    taxIncludedInPrice,
  });
  const fmt = useLocalePrice();
  const row = 'flex items-baseline justify-between gap-4';

  return (
    <aside
      dir={isRtl ? 'rtl' : 'ltr'}
      className="rounded-[var(--radius)] border border-border bg-card p-6 sm:p-7"
      aria-label={isRtl ? 'ملخص الطلب' : 'Order summary'}
    >
      <h2
        className="font-display text-2xl text-foreground"
        style={{ ...typography?.heading, ...labelColorStyle }}
      >
        {isRtl ? 'ملخص الطلب' : 'Order summary'}
      </h2>
      <dl className="mt-6 space-y-3 text-sm" aria-live="polite">
        <div className={row}>
          <dt
            className="text-muted-foreground"
            style={{ ...typography?.label, ...labelColorStyle }}
          >
            {isRtl ? 'المجموع الفرعي' : 'Subtotal'}
          </dt>
          <dd className="tabular-nums text-foreground" style={typography?.price}>
            {fmt(subtotal)}
          </dd>
        </div>
        {discount > 0 && (
          <div className={cx(row, 'text-success-ink')}>
            <dt style={typography?.label}>{discountLabel ?? (isRtl ? 'الخصم' : 'Discount')}</dt>
            <dd className="tabular-nums" style={typography?.price}>
              <SignedAmount sign={MINUS} value={fmt(discount)} />
            </dd>
          </div>
        )}
        <div className={row}>
          <dt
            className="text-muted-foreground"
            style={{ ...typography?.label, ...labelColorStyle }}
          >
            {isRtl ? 'التوصيل' : 'Delivery'}
          </dt>
          <dd className="tabular-nums text-foreground" style={typography?.price}>
            {shippingPending ? (
              <span className="text-muted-foreground">
                {isRtl ? 'يحسب في الخطوة التالية' : 'Calculated at checkout'}
              </span>
            ) : freeShipping ? (
              <span className="text-primary">{isRtl ? 'مجاني' : 'Free'}</span>
            ) : (
              fmt(shipping)
            )}
          </dd>
        </div>
        {tax > 0 && !taxIncludedInPrice && (
          <div className={row}>
            <dt className="text-muted-foreground" style={typography?.label}>
              {taxLabel}
            </dt>
            <dd className="tabular-nums text-foreground" style={typography?.price}>
              {fmt(tax)}
            </dd>
          </div>
        )}
        <div className={cx(row, 'border-t border-border pt-4')}>
          <dt
            className="text-base text-foreground"
            style={{ ...typography?.heading, ...totalColorStyle }}
          >
            {isRtl ? 'الإجمالي' : 'Total'}
          </dt>
          <dd
            className="text-xl tabular-nums text-primary"
            style={{ ...typography?.price, ...totalColorStyle }}
          >
            {fmt(total)}
          </dd>
        </div>
      </dl>
      {tax > 0 && taxIncludedInPrice && (
        <p className="mt-2 text-xs text-muted-foreground">
          {taxLabel} {fmt(tax)}
        </p>
      )}
      {children && <div className="mt-6">{children}</div>}
      {ctaDisabled && ctaBlockedMessage && (
        <p className="mt-5 rounded-[var(--radius)] border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-ink">
          {ctaBlockedMessage}
        </p>
      )}
      {ctaText &&
        (ctaHref && !ctaDisabled ? (
          <Link
            href={ctaHref}
            data-cta="button"
            className={cx(DAHAB_BTN_PRIMARY, 'mt-6 w-full')}
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
            className={cx(DAHAB_BTN_PRIMARY, 'mt-6 w-full')}
            style={typography?.cta}
          >
            {ctaLoading ? (
              '…'
            ) : (
              <>
                {ctaText}
                <ArrowIcon className="h-4 w-4 shrink-0" isRtl={isRtl} />
              </>
            )}
          </button>
        ))}
      <DahabPaymentMarks className="mt-6 justify-center" />
    </aside>
  );
}

/** This summary prints money with `useLocalePrice` (see `summaryMoneyFormatter`). */
DahabOrderSummary.moneyFormat = 'locale' as const;
