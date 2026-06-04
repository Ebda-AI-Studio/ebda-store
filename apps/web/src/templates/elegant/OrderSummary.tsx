'use client';

import Link from 'next/link';
import type { OrderSummaryProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

export default function ElegantOrderSummary({
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
      className="border-t border-foreground/20 pt-8"
      aria-label={isRtl ? 'ملخص الطلب' : 'Order summary'}
    >
      <h2
        className="text-xs font-light uppercase tracking-[0.3em] text-muted-foreground"
        style={typography?.heading}
      >
        {isRtl ? 'ملخص الطلب' : 'Order Summary'}
      </h2>
      <dl className="mt-8 space-y-5 text-sm font-light" aria-live="polite">
        <div className="flex items-center justify-between">
          <dt className="tracking-wide text-muted-foreground" style={typography?.label}>
            {isRtl ? 'المجموع الفرعي' : 'Subtotal'}
          </dt>
          <dd className="tracking-wide text-foreground" style={typography?.price}>
            {fmt(subtotal)}
          </dd>
        </div>
        {discount > 0 && (
          <div className="flex items-center justify-between text-success">
            <dt className="tracking-wide" style={typography?.label}>
              {discountLabel ?? (isRtl ? 'الخصم' : 'Discount')}
            </dt>
            <dd className="tracking-wide" style={typography?.price}>
              −{fmt(discount)}
            </dd>
          </div>
        )}
        <div className="flex items-center justify-between">
          <dt className="tracking-wide text-muted-foreground" style={typography?.label}>
            {isRtl ? 'الشحن' : 'Shipping'}
          </dt>
          <dd className="tracking-wide text-foreground" style={typography?.price}>
            {freeShipping ? (
              <span className="text-success uppercase tracking-[0.2em] text-xs">
                {isRtl ? 'مجاني' : 'Complimentary'}
              </span>
            ) : (
              fmt(shipping)
            )}
          </dd>
        </div>
        {tax > 0 && (
          <div className="flex items-center justify-between">
            <dt className="tracking-wide text-muted-foreground" style={typography?.label}>
              {isRtl ? 'الضريبة' : 'Tax'}
            </dt>
            <dd className="tracking-wide text-foreground" style={typography?.price}>
              {fmt(tax)}
            </dd>
          </div>
        )}
        <div className="mt-8 flex items-baseline justify-between border-t border-foreground/20 pt-8">
          <dt
            className="text-xs font-light uppercase tracking-[0.3em] text-foreground"
            style={typography?.heading}
          >
            {isRtl ? 'الإجمالي' : 'Total'}
          </dt>
          <dd
            className="text-xl font-light tracking-wide text-foreground"
            style={typography?.price}
          >
            {fmt(total)}
          </dd>
        </div>
      </dl>
      {children && <div className="mt-8">{children}</div>}
      {ctaText &&
        (ctaHref ? (
          <Link
            href={ctaHref}
            className="mt-8 flex h-12 w-full items-center justify-center border border-foreground bg-foreground px-4 text-xs font-medium uppercase tracking-[0.3em] text-background hover:bg-foreground/85 transition-colors duration-700 ease-out focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2"
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
            className="mt-8 flex h-12 w-full items-center justify-center border border-foreground bg-foreground px-4 text-xs font-medium uppercase tracking-[0.3em] text-background hover:bg-foreground/85 disabled:opacity-40 transition-colors duration-700 ease-out focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2"
            style={typography?.cta}
          >
            {ctaLoading ? '···' : ctaText}
          </button>
        ))}
    </aside>
  );
}
