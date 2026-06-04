'use client';

import Link from 'next/link';
import type { OrderSummaryProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

export default function BoldOrderSummary({
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
      className="border-2 border-foreground bg-background"
      aria-label={isRtl ? 'ملخص الطلب' : 'Order summary'}
    >
      <h2
        className="border-b-2 border-foreground bg-foreground px-5 py-3 text-sm font-black uppercase tracking-widest text-background"
        style={typography?.heading}
      >
        {isRtl ? 'ملخص الطلب' : 'Order Summary'}
      </h2>
      <dl className="space-y-3 p-5 text-sm" aria-live="polite">
        <div className="flex items-center justify-between">
          <dt
            className="font-bold uppercase tracking-wider text-muted-foreground"
            style={typography?.label}
          >
            {isRtl ? 'المجموع الفرعي' : 'Subtotal'}
          </dt>
          <dd className="font-black text-foreground" style={typography?.price}>
            {fmt(subtotal)}
          </dd>
        </div>
        {discount > 0 && (
          <div className="flex items-center justify-between text-success">
            <dt className="font-bold uppercase tracking-wider" style={typography?.label}>
              {discountLabel ?? (isRtl ? 'الخصم' : 'Discount')}
            </dt>
            <dd className="font-black" style={typography?.price}>
              −{fmt(discount)}
            </dd>
          </div>
        )}
        <div className="flex items-center justify-between">
          <dt
            className="font-bold uppercase tracking-wider text-muted-foreground"
            style={typography?.label}
          >
            {isRtl ? 'الشحن' : 'Shipping'}
          </dt>
          <dd className="font-black text-foreground" style={typography?.price}>
            {freeShipping ? (
              <span className="text-success">{isRtl ? 'مجاني' : 'FREE'}</span>
            ) : (
              fmt(shipping)
            )}
          </dd>
        </div>
        {tax > 0 && (
          <div className="flex items-center justify-between">
            <dt
              className="font-bold uppercase tracking-wider text-muted-foreground"
              style={typography?.label}
            >
              {isRtl ? 'الضريبة' : 'Tax'}
            </dt>
            <dd className="font-black text-foreground" style={typography?.price}>
              {fmt(tax)}
            </dd>
          </div>
        )}
        <div className="mt-3 flex items-baseline justify-between border-t-2 border-foreground pt-3">
          <dt
            className="text-base font-black uppercase tracking-tight text-foreground"
            style={typography?.heading}
          >
            {isRtl ? 'الإجمالي' : 'Total'}
          </dt>
          <dd
            className="text-2xl font-black tracking-tight text-foreground"
            style={typography?.price}
          >
            {fmt(total)}
          </dd>
        </div>
      </dl>
      {children && <div className="border-t-2 border-foreground p-5">{children}</div>}
      {ctaText && (
        <div className="border-t-2 border-foreground">
          {ctaHref ? (
            <Link
              href={ctaHref}
              className="flex h-14 w-full items-center justify-center bg-primary px-5 text-sm font-black uppercase tracking-[0.18em] text-primary-foreground hover:bg-primary/90 transition-colors duration-200 ease-out focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2"
              aria-disabled={ctaDisabled}
              style={typography?.cta}
            >
              {ctaText} →
            </Link>
          ) : (
            <button
              type="button"
              onClick={onCtaClick}
              disabled={ctaDisabled || ctaLoading}
              className="flex h-14 w-full items-center justify-center bg-primary px-5 text-sm font-black uppercase tracking-[0.18em] text-primary-foreground hover:bg-primary/90 transition-colors duration-200 ease-out disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2"
              style={typography?.cta}
            >
              {ctaLoading ? '···' : `${ctaText} →`}
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
