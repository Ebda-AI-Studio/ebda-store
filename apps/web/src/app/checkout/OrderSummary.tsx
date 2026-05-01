'use client';

import Image from 'next/image';
import { Button, Input } from '@force/ui';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { formatPrice } from '@/lib/format';
import type { CheckoutCartItem, Coupon } from './types';

interface OrderSummaryProps {
  items: CheckoutCartItem[];
  subtotal: number;
  discount: number;
  shipping: number;
  total: number;
  freeShipping: boolean;
  couponCode: string;
  onCouponCodeChange: (code: string) => void;
  appliedCoupon: Coupon | null;
  onApplyCoupon: () => void;
  onRemoveCoupon: () => void;
  couponError: string;
}

export function OrderSummary({
  items,
  subtotal,
  discount,
  shipping,
  total,
  freeShipping,
  couponCode,
  onCouponCodeChange,
  appliedCoupon,
  onApplyCoupon,
  onRemoveCoupon,
  couponError,
}: OrderSummaryProps) {
  const { t, isRtl } = useLanguage();
  // Localised product name on the order summary line — checkout +
  // payment review need to mirror the storefront which already shows
  // Arabic names. Falls back to `name` when nameAr isn't set.
  const productLabel = (p: { name: string; nameAr?: string }) =>
    isRtl && p.nameAr ? p.nameAr : p.name;

  return (
    <div className="mt-8 lg:col-span-5 lg:mt-0">
      <div className="sticky top-24 rounded-xl border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-foreground">
          {t('Order Summary', translations['Order Summary'])}
        </h2>

        <div className="mt-6 divide-y">
          {items.map(item => (
            <div key={item.id} className="flex gap-4 py-4 first:pt-0">
              <div className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg bg-muted">
                {item.product.images?.[0] ? (
                  <Image
                    src={item.product.images[0].url}
                    alt={productLabel(item.product)}
                    fill
                    className="object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <svg
                      className="h-6 w-6 text-muted-foreground/70"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                      />
                    </svg>
                  </div>
                )}
                <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-muted-foreground text-xs text-white">
                  {item.quantity}
                </span>
              </div>
              <div className="flex flex-1 flex-col">
                <h3 className="text-sm font-medium text-foreground">
                  {productLabel(item.product)}
                </h3>
                <p className="mt-auto text-sm font-medium text-muted-foreground">
                  {formatPrice(item.price * item.quantity)}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Coupon */}
        <div className="mt-6 border-t pt-6">
          {appliedCoupon ? (
            <div className="flex items-center justify-between bg-[hsl(var(--success))]/10 p-3 rounded-lg">
              <div>
                <span className="text-sm font-medium text-[hsl(var(--success))]">
                  {appliedCoupon.code}
                </span>
                <span className="text-sm text-[hsl(var(--success))] ml-2">
                  {appliedCoupon.type === 'percentage'
                    ? `${appliedCoupon.value}% ${t('off', '\u062e\u0635\u0645')}`
                    : appliedCoupon.type === 'free_shipping'
                      ? t('Free shipping', '\u0634\u062d\u0646 \u0645\u062c\u0627\u0646\u064a')
                      : `${formatPrice(appliedCoupon.value)} ${t('off', '\u062e\u0635\u0645')}`}
                </span>
              </div>
              <button
                onClick={onRemoveCoupon}
                className="text-[hsl(var(--success))] hover:text-[hsl(var(--success))]/80"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Input
                placeholder={t('Coupon code', '\u0643\u0648\u062f \u0627\u0644\u062e\u0635\u0645')}
                value={couponCode}
                onChange={e => onCouponCodeChange(e.target.value.toUpperCase())}
                className="flex-1"
              />
              <Button type="button" variant="outline" onClick={onApplyCoupon}>
                {t('Apply', translations['Apply'])}
              </Button>
            </div>
          )}
          {couponError && <p className="mt-2 text-sm text-destructive">{couponError}</p>}
        </div>

        {/* Totals */}
        <div className="mt-6 space-y-3 border-t pt-6">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">{t('Subtotal', translations['Subtotal'])}</span>
            <span className="font-medium">{formatPrice(subtotal)}</span>
          </div>
          {discount > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-[hsl(var(--success))]">
                {t('Discount', '\u0627\u0644\u062e\u0635\u0645')}
              </span>
              <span className="font-medium text-[hsl(var(--success))]">
                -{formatPrice(discount)}
              </span>
            </div>
          )}
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">{t('Shipping', translations['Shipping'])}</span>
            <span className={`font-medium ${freeShipping ? 'text-[hsl(var(--success))]' : ''}`}>
              {freeShipping
                ? t('Free', translations['Free'])
                : shipping > 0
                  ? formatPrice(shipping)
                  : t(
                      'Select area',
                      '\u0627\u062e\u062a\u0631 \u0627\u0644\u0645\u0646\u0637\u0642\u0629'
                    )}
            </span>
          </div>
          <div className="flex justify-between border-t pt-3">
            <span className="text-lg font-semibold text-foreground">
              {t('Total', translations['Total'])}
            </span>
            <span className="text-lg font-bold text-primary">{formatPrice(total)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
