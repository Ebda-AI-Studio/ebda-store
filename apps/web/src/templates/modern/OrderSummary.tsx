'use client';

import Link from 'next/link';
import type { OrderSummaryProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

export default function ModernOrderSummary({
  subtotal,
  discount = 0,
  discountLabel,
  shipping = 0,
  freeShipping = false,
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
  typography,
}: OrderSummaryProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const fmt = (p: number) => `${(p / 1000).toFixed(3)} ${currency}`;
  const ctaText = isRtl ? (ctaLabelAr ?? ctaLabel) : (ctaLabel ?? ctaLabelAr);

  return (
    <aside
      dir={isRtl ? 'rtl' : 'ltr'}
      className="rounded-2xl border border-border/60 bg-card p-7 shadow-[0_18px_36px_-22px_hsl(var(--foreground)/0.10)]"
      aria-label={isRtl ? 'ملخص الطلب' : 'Order summary'}
    >
      <h2
        className="text-lg font-semibold text-foreground tracking-tight"
        style={typography?.heading}
      >
        {isRtl ? 'ملخص الطلب' : 'Order Summary'}
      </h2>
      <dl className="mt-5 space-y-3 text-sm" aria-live="polite">
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground" style={typography?.label}>
            {isRtl ? 'المجموع الفرعي' : 'Subtotal'}
          </dt>
          <dd className="font-medium text-foreground" style={typography?.price}>
            {fmt(subtotal)}
          </dd>
        </div>
        {discount > 0 && (
          <div className="flex items-center justify-between text-success">
            <dt style={typography?.label}>{discountLabel ?? (isRtl ? 'الخصم' : 'Discount')}</dt>
            <dd className="font-medium" style={typography?.price}>
              −{fmt(discount)}
            </dd>
          </div>
        )}
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground" style={typography?.label}>
            {isRtl ? 'الشحن' : 'Shipping'}
          </dt>
          <dd className="font-medium text-foreground" style={typography?.price}>
            {freeShipping ? (
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
            <dd className="font-medium text-foreground" style={typography?.price}>
              {fmt(tax)}
            </dd>
          </div>
        )}
        <div className="mt-4 flex items-baseline justify-between border-t border-border/60 pt-4">
          <dt className="text-base font-semibold text-foreground" style={typography?.heading}>
            {isRtl ? 'الإجمالي' : 'Total'}
          </dt>
          <dd className="text-xl font-bold text-primary" style={typography?.price}>
            {fmt(total)}
          </dd>
        </div>
      </dl>
      {children && <div className="mt-5">{children}</div>}
      {ctaText &&
        (ctaHref ? (
          <Link
            href={ctaHref}
            className="mt-6 flex h-12 w-full items-center justify-center rounded-xl bg-primary px-4 text-sm font-semibold tracking-tight text-primary-foreground transition-all duration-300 ease-out hover:bg-primary/90 hover:shadow-[0_18px_40px_-18px_hsl(var(--primary)/0.45)] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            aria-disabled={ctaDisabled}
            style={typography?.cta}
          >
            {ctaText}
          </Link>
        ) : (
          <button
            type="button"
            onClick={onCtaClick}
            disabled={ctaDisabled || ctaLoading}
            className="mt-6 flex h-12 w-full items-center justify-center rounded-xl bg-primary px-4 text-sm font-semibold tracking-tight text-primary-foreground transition-all duration-300 ease-out hover:bg-primary/90 hover:shadow-[0_18px_40px_-18px_hsl(var(--primary)/0.45)] disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            style={typography?.cta}
          >
            {ctaLoading ? (
              <span
                className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent"
                aria-hidden
              />
            ) : (
              ctaText
            )}
          </button>
        ))}
    </aside>
  );
}
