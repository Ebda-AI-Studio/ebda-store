'use client';

import Link from 'next/link';
import type { OrderSummaryProps } from '../types';
import { useLanguage } from '../../contexts/LanguageContext';

export default function MinimalOrderSummary({
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
    <aside dir={isRtl ? 'rtl' : 'ltr'} aria-label={isRtl ? 'ملخص الطلب' : 'Order summary'}>
      <dl className="space-y-4 text-sm" aria-live="polite">
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">{isRtl ? 'المجموع الفرعي' : 'Subtotal'}</dt>
          <dd className="text-foreground">{fmt(subtotal)}</dd>
        </div>
        {discount > 0 && (
          <div className="flex items-center justify-between text-success">
            <dt>{discountLabel ?? (isRtl ? 'الخصم' : 'Discount')}</dt>
            <dd>−{fmt(discount)}</dd>
          </div>
        )}
        <div className="flex items-center justify-between">
          <dt className="text-muted-foreground">{isRtl ? 'الشحن' : 'Shipping'}</dt>
          <dd className="text-foreground">
            {freeShipping ? (
              <span className="text-success">{isRtl ? 'مجاني' : 'Free'}</span>
            ) : (
              fmt(shipping)
            )}
          </dd>
        </div>
        {tax > 0 && (
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">{isRtl ? 'الضريبة' : 'Tax'}</dt>
            <dd className="text-foreground">{fmt(tax)}</dd>
          </div>
        )}
        <div className="flex items-baseline justify-between border-t border-border pt-5">
          <dt className="text-foreground">{isRtl ? 'الإجمالي' : 'Total'}</dt>
          <dd className="text-lg text-foreground">{fmt(total)}</dd>
        </div>
      </dl>
      {children && <div className="mt-6">{children}</div>}
      {ctaText &&
        (ctaHref ? (
          <Link
            href={ctaHref}
            className="mt-8 block border-b border-foreground pb-1 text-sm text-foreground hover:border-foreground/40 hover:text-foreground/70 transition-colors duration-500 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground"
            aria-disabled={ctaDisabled}
          >
            {ctaText} →
          </Link>
        ) : (
          <button
            type="button"
            onClick={onCtaClick}
            disabled={ctaDisabled || ctaLoading}
            className="mt-8 block w-fit border-b border-foreground pb-1 text-sm text-foreground hover:border-foreground/40 hover:text-foreground/70 transition-colors duration-500 ease-out disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground"
          >
            {ctaLoading ? '···' : `${ctaText} →`}
          </button>
        ))}
    </aside>
  );
}
