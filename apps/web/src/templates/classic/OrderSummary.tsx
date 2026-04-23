'use client';

import Link from 'next/link';
import type { OrderSummaryProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

export default function ClassicOrderSummary({
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
}: OrderSummaryProps) {
  const { isRtl: ctxIsRtl } = useLanguage();
  const isRtl = isRtlProp ?? ctxIsRtl;
  const fmt = (p: number) => `${(p / 1000).toFixed(3)} ${currency}`;
  const ctaText = isRtl ? (ctaLabelAr ?? ctaLabel) : (ctaLabel ?? ctaLabelAr);

  return (
    <aside
      dir={isRtl ? 'rtl' : 'ltr'}
      className="border border-border bg-background p-6"
      aria-label={isRtl ? 'ملخص الطلب' : 'Order summary'}
    >
      <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        {isRtl ? 'ملخص الطلب' : 'Order Summary'}
      </h2>
      <dl className="mt-6 space-y-4 text-sm" aria-live="polite">
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">{isRtl ? 'المجموع الفرعي' : 'Subtotal'}</dt>
          <dd className="tracking-tight text-foreground">{fmt(subtotal)}</dd>
        </div>
        {discount > 0 && (
          <div className="flex items-center justify-between text-success">
            <dt>{discountLabel ?? (isRtl ? 'الخصم' : 'Discount')}</dt>
            <dd>−{fmt(discount)}</dd>
          </div>
        )}
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">{isRtl ? 'الشحن' : 'Shipping'}</dt>
          <dd className="tracking-tight text-foreground">
            {freeShipping ? (
              <span className="text-success uppercase text-xs">{isRtl ? 'مجاني' : 'Free'}</span>
            ) : (
              fmt(shipping)
            )}
          </dd>
        </div>
        {tax > 0 && (
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">{isRtl ? 'الضريبة' : 'Tax'}</dt>
            <dd className="tracking-tight text-foreground">{fmt(tax)}</dd>
          </div>
        )}
        <div className="mt-6 flex items-baseline justify-between border-t border-border pt-6">
          <dt className="text-xs font-semibold uppercase tracking-widest text-foreground">
            {isRtl ? 'الإجمالي' : 'Total'}
          </dt>
          <dd className="text-lg font-semibold tracking-tight text-foreground">{fmt(total)}</dd>
        </div>
      </dl>
      {children && <div className="mt-6">{children}</div>}
      {ctaText &&
        (ctaHref ? (
          <Link
            href={ctaHref}
            className="mt-6 flex h-12 w-full items-center justify-center border border-foreground bg-foreground px-4 text-xs font-semibold uppercase tracking-widest text-background hover:bg-foreground/90 focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2"
            aria-disabled={ctaDisabled}
          >
            {ctaText}
          </Link>
        ) : (
          <button
            type="button"
            onClick={onCtaClick}
            disabled={ctaDisabled || ctaLoading}
            className="mt-6 flex h-12 w-full items-center justify-center border border-foreground bg-foreground px-4 text-xs font-semibold uppercase tracking-widest text-background hover:bg-foreground/90 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2"
          >
            {ctaLoading ? (isRtl ? 'جارٍ...' : 'Processing...') : ctaText}
          </button>
        ))}
    </aside>
  );
}
