'use client';

import Image from 'next/image';
import { MINUS, SignedAmount } from '@/lib/bidi';
import { useLocalePrice } from '../../hooks/useLocalePrice';
import { Button, Input, VariantText } from '@ebda/ui';
import { useEffect, useId, useRef, type CSSProperties } from 'react';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { useNumerals } from '../../hooks/useNumerals';
import { formatTaxRowLabel } from '../../lib/tax-display';
import { BundleLine } from '../../components/BundleLine';
import { CartLineNote } from '../../components/commerce/CartLineNote';
import { GoldRateLine } from '../../components/commerce/GoldRateLine';
import type { CheckoutCartItem, CheckoutCartBundle, Coupon } from './types';

/** Loyalty redemption control state, threaded from CheckoutClient. Present
 *  only for logged-in customers with a positive balance on a loyalty-enabled
 *  store; undefined otherwise (the block doesn't render). */
export interface LoyaltyRedeemControl {
  /** Current available points balance. */
  points: number;
  /** Piastres per point (for the value estimate). */
  pointsValue: number;
  /** Store minimum points required to redeem. */
  minRedeemPoints: number;
  /** Whether redemption is toggled on for this order. */
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  /** Points the customer chose to redeem. */
  pointsToRedeem: number;
  onPointsChange: (points: number) => void;
  /** Discount (piastres) the redemption currently yields (already capped). */
  loyaltyDiscount: number;
}

/** Customer-wallet (store credit, D1) spend control, threaded from
 *  CheckoutClient. Present only for signed-in customers with a positive
 *  balance on a store whose wallet checkout the API reports as available;
 *  undefined otherwise (nothing renders). */
export interface WalletSpendControl {
  /** Current wallet balance in piastres. */
  balance: number;
  /** Whether the customer chose to pay from the wallet for this order. */
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  /** Piastres the wallet covers on this order (display estimate; the server
   *  re-resolves it at order creation). */
  applied: number;
}

/** Resolved summary-label color overrides from StoreTheme flags. */
export interface SummaryColors {
  /** CSS color for row labels (Order Summary heading, Subtotal, Shipping). */
  labelColor?: string;
  /** CSS color for the grand-total label + amount. */
  totalColor?: string;
  /** Whether labels render bold (default true). */
  bold?: boolean;
}

interface OrderSummaryProps {
  items: CheckoutCartItem[];
  /** Bundle boxes in the cart — each rendered as ONE row via `BundleLine`,
   *  never the per-component allocated prices. */
  bundles?: CheckoutCartBundle[];
  subtotal: number;
  discount: number;
  /** The automatic-promotion portion of `discount` (0 when no promotion is
   *  currently the winning lever vs. an applied coupon) — rendered as its
   *  own labelled line, display-only; the server recomputes authoritatively
   *  at order creation. */
  promotionDiscount?: number;
  shipping: number;
  /** Cash-on-delivery fee quoted for this order (0 = none / not COD). Shown
   *  as its own row and already inside `total` (ruling MONEYB-3). */
  codFee?: number;
  /** VAT amount in piastres, computed via `computeOrderTax` (same formula the
   *  API charges at order creation — ruling M3-3 in docs/RULINGS.md). 0
   *  for a store with no active tax rate — renders nothing. */
  tax: number;
  /** The store's active VAT rate as a percentage (e.g. 5 for 5%), used only
   *  to label the row ("VAT (5%)"). */
  taxRatePercent: number;
  /** When true, `tax` is already included in `subtotal` — the row renders
   *  as an informational "Incl. VAT (5%)" note and is NOT part of `total`. */
  taxIncludedInPrice: boolean;
  total: number;
  freeShipping: boolean;
  /** C3: store has no delivery rates; the line says the store sets the fee, never "Free". */
  shippingToConfirm?: boolean;
  /** C4: an area is chosen, so a 0 fee is a known price (free), not "pick an area". */
  shippingAreaChosen?: boolean;
  couponCode: string;
  onCouponCodeChange: (code: string) => void;
  appliedCoupon: Coupon | null;
  onApplyCoupon: () => void;
  onRemoveCoupon: () => void;
  couponError: string;
  /** Loyalty redemption control — omitted for guests / no balance. */
  loyalty?: LoyaltyRedeemControl;
  /** Wallet spend control — omitted unless wallet checkout is available. */
  wallet?: WalletSpendControl;
  /** Per-store checkout typography (page-builder → Checkout page). */
  typography?: { heading?: CSSProperties; label?: CSSProperties; price?: CSSProperties };
  /** Per-store summary-label color + bold overrides from StoreTheme. */
  summaryColors?: SummaryColors;
}

export function OrderSummary({
  items,
  bundles = [],
  subtotal,
  discount,
  promotionDiscount = 0,
  shipping,
  codFee = 0,
  tax,
  taxRatePercent,
  taxIncludedInPrice,
  total,
  freeShipping,
  shippingToConfirm = false,
  shippingAreaChosen = false,
  couponCode,
  onCouponCodeChange,
  appliedCoupon,
  onApplyCoupon,
  onRemoveCoupon,
  couponError,
  loyalty,
  wallet,
  typography,
  summaryColors,
}: OrderSummaryProps) {
  const { t, isRtl } = useLanguage();
  const { localize } = useNumerals();
  const formatPrice = useLocalePrice();
  // a11y re-audit P1-N1: a refused code returns focus to its field, which names the error.
  const couponErrorId = useId();
  const couponFieldRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (couponError) couponFieldRef.current?.focus();
  }, [couponError]);
  const taxLabel = formatTaxRowLabel(tax, taxRatePercent, taxIncludedInPrice, isRtl, localize);
  const summaryLabelBold = summaryColors?.bold !== false;
  const summaryFontWeight = summaryLabelBold ? 'font-bold' : 'font-normal';
  const labelColorStyle = summaryColors?.labelColor
    ? { color: summaryColors.labelColor }
    : undefined;
  const totalColorStyle = summaryColors?.totalColor
    ? { color: summaryColors.totalColor }
    : undefined;
  // EGP formatting for the points-value hint (pointsValue is piastres/point).
  const pointsValueLabel = (points: number) =>
    loyalty ? formatPrice(points * loyalty.pointsValue) : '';
  // Localised product name on the order summary line — checkout +
  // payment review need to mirror the storefront which already shows
  // Arabic names. Falls back to `name` when nameAr isn't set.
  const productLabel = (p: { name: string; nameAr?: string }) =>
    isRtl && p.nameAr ? p.nameAr : p.name;

  return (
    <div className="order-2 mt-8 lg:order-none lg:col-span-4 lg:mt-0">
      <div
        data-part="order-summary"
        className="sticky top-24 rounded-[var(--radius)] border bg-card p-6 shadow-sm"
      >
        <h2 className="text-lg font-bold text-foreground" style={typography?.heading}>
          {t('Order summary', translations['Order Summary'])}
        </h2>

        <div className="mt-6 divide-y">
          {bundles.map(bundle => (
            <BundleLine
              key={bundle.id}
              variant="row"
              name={bundle.name}
              nameAr={bundle.nameAr}
              image={bundle.image}
              quantity={bundle.quantity}
              total={bundle.total}
              available={bundle.available}
              isRtl={isRtl}
            />
          ))}
          {items.map(item => (
            <div key={item.id} className="flex gap-4 py-4 first:pt-0">
              {/* IA-07: the badge sits outside the clipped thumbnail, logical, on the ink pair. */}
              <div className="relative h-16 w-16 flex-shrink-0" data-part="summary-thumb">
                <div className="relative h-full w-full overflow-hidden rounded-[var(--radius)] bg-muted">
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
                        className="h-6 w-6 text-muted-foreground"
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
                </div>
                <span
                  data-testid="line-qty-badge"
                  className="absolute -end-1 -top-1 z-10 flex h-5 min-w-5 items-center justify-center rounded-full bg-foreground px-1 text-xs text-background"
                >
                  {localize(item.quantity)}
                </span>
              </div>
              <div className="flex flex-1 flex-col">
                <h3 className="text-base font-semibold text-foreground">
                  {productLabel(item.product)}
                </h3>
                {/* IA-02: the variant, as the cart and the receipt print it. */}
                {(item.variantTitle || item.variantTitleAr) && (
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    <VariantText
                      title={
                        (isRtl && item.variantTitleAr
                          ? item.variantTitleAr
                          : item.variantTitle || item.variantTitleAr) ?? ''
                      }
                    />
                  </p>
                )}
                <CartLineNote note={item.note} />
                <GoldRateLine gold={item.gold} className="mt-1" />
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
            // data-zone="cta" wires this block into the per-store typography CSS emitter
            <div
              data-zone="cta"
              className="flex items-center justify-between bg-success/10 p-3 sm:p-4 rounded-lg"
            >
              <div>
                <span className="text-sm font-medium text-success-ink">{appliedCoupon.code}</span>
                <span className="text-sm text-success-ink ms-2">
                  {appliedCoupon.type === 'percentage'
                    ? `${localize(appliedCoupon.value)}% ${t('off', 'خصم')}`
                    : appliedCoupon.type === 'free_shipping'
                      ? t('Free shipping', 'شحن مجاني')
                      : `${formatPrice(appliedCoupon.value)} ${t('off', 'خصم')}`}
                </span>
              </div>
              <button
                onClick={onRemoveCoupon}
                className="text-success-ink hover:text-success-ink/80"
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
                ref={couponFieldRef}
                // P2-7 (W4): a placeholder is not a label.
                aria-label={t('Coupon code', 'كود الخصم')}
                placeholder={t('Coupon code', '\u0643\u0648\u062f \u0627\u0644\u062e\u0635\u0645')}
                value={couponCode}
                onChange={e => onCouponCodeChange(e.target.value.toUpperCase())}
                // a11y re-audit P1-N1: Enter applies, the field says it is invalid and names its error.
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    onApplyCoupon();
                  }
                }}
                aria-invalid={couponError ? true : undefined}
                aria-describedby={couponError ? couponErrorId : undefined}
                className="flex-1 sm:h-11"
              />
              <Button type="button" variant="outline" onClick={onApplyCoupon}>
                {t('Apply', translations['Apply'])}
              </Button>
            </div>
          )}
          {couponError && (
            <p id={couponErrorId} role="alert" className="mt-2 text-sm text-destructive-ink">
              {couponError}
            </p>
          )}
          {/* A coupon never discounts a bundle (the box price already is the
              discount), and the quote is computed against the loose items
              only — say so, or the customer reads a 10% coupon returning
              almost nothing as a bug. Only rendered when BOTH a bundle and a
              coupon are present, so a non-bundle order is unchanged. */}
          {appliedCoupon && bundles.length > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t(
                'Coupon applies to items outside your bundles — a bundle is already discounted.',
                translations[
                  'Coupon applies to items outside your bundles — a bundle is already discounted.'
                ]
              )}
            </p>
          )}
        </div>

        {/* Loyalty points redemption — only for logged-in customers with a
            positive balance on a loyalty-enabled store. */}
        {loyalty && (
          <div className="mt-6 border-t pt-6">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={loyalty.enabled}
                onChange={e => {
                  loyalty.onToggle(e.target.checked);
                  // Default to redeeming the full balance when first enabled.
                  if (e.target.checked && loyalty.pointsToRedeem <= 0) {
                    loyalty.onPointsChange(loyalty.points);
                  }
                }}
                className="mt-1 h-4 w-4 rounded border-input accent-primary focus-visible:ring-2 focus-visible:ring-ring"
              />
              <span className="flex-1">
                <span className="text-sm font-medium text-foreground">
                  {t('Use loyalty points', 'استخدام نقاط الولاء')}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t('Balance', 'الرصيد')}: {localize(loyalty.points.toLocaleString('en-US'))}{' '}
                  {t('points', 'نقطة')}
                  {' · '}
                  {t('worth', 'بقيمة')} {pointsValueLabel(loyalty.points)}
                </span>
              </span>
            </label>

            {loyalty.enabled && (
              <div className="mt-3 ps-7">
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={loyalty.points}
                    step={1}
                    value={loyalty.pointsToRedeem || ''}
                    onChange={e => {
                      const raw = parseInt(e.target.value, 10);
                      const clamped = Number.isFinite(raw)
                        ? Math.max(0, Math.min(raw, loyalty.points))
                        : 0;
                      loyalty.onPointsChange(clamped);
                    }}
                    className="w-32"
                    aria-label={t('Points to redeem', 'النقاط المراد استخدامها')}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => loyalty.onPointsChange(loyalty.points)}
                  >
                    {t('Max', 'الكل')}
                  </Button>
                </div>
                {loyalty.pointsToRedeem > 0 && loyalty.pointsToRedeem < loyalty.minRedeemPoints && (
                  <p className="mt-2 text-sm text-destructive-ink">
                    {t('Minimum', 'الحد الأدنى')}{' '}
                    {localize(loyalty.minRedeemPoints.toLocaleString('en-US'))}{' '}
                    {t('points to redeem', 'نقطة للاستخدام')}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Customer wallet (store credit) — only when the API reports wallet
            checkout as available for this signed-in customer. */}
        {wallet && (
          <div className="mt-6 border-t pt-6">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={wallet.enabled}
                onChange={e => wallet.onToggle(e.target.checked)}
                className="mt-1 h-6 w-6 rounded border-input accent-primary focus-visible:ring-2 focus-visible:ring-ring"
              />
              <span className="flex-1">
                <span className="text-sm font-medium text-foreground">
                  {t('Use wallet balance', 'استخدام رصيد المحفظة')} ({formatPrice(wallet.balance)})
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t(
                    'Your store credit is applied first; you pay the rest as usual.',
                    'رصيد المتجر بيتخصم الأول، والباقي تدفعه بالطريقة العادية.'
                  )}
                </span>
              </span>
            </label>
          </div>
        )}

        {/* Totals */}
        <div className="mt-6 space-y-3 border-t pt-6">
          <div className="flex justify-between text-sm">
            <span
              className={`${summaryFontWeight} text-muted-foreground`}
              style={{ ...typography?.label, ...labelColorStyle }}
            >
              {t('Subtotal', translations['Subtotal'])}
            </span>
            <span className="font-medium tabular-nums" style={typography?.price}>
              {formatPrice(subtotal)}
            </span>
          </div>
          {(() => {
            // `discount` is coupon + promotion (best-of, never both — see
            // CheckoutClient's primaryDiscount) + loyalty combined. Show each
            // portion as its own line so the customer sees exactly what
            // saved them what.
            const loyaltyDiscount = loyalty?.loyaltyDiscount ?? 0;
            const couponPortion = Math.max(0, discount - loyaltyDiscount - promotionDiscount);
            return (
              <>
                {couponPortion > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-success-ink" style={typography?.label}>
                      {t('Discount', 'الخصم')}
                    </span>
                    <span
                      className="font-medium text-success-ink tabular-nums"
                      style={typography?.price}
                    >
                      <SignedAmount sign={MINUS} value={formatPrice(couponPortion)} />
                    </span>
                  </div>
                )}
                {promotionDiscount > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-success-ink" style={typography?.label}>
                      {t('Promotion', translations['Promotion'])}
                    </span>
                    <span
                      className="font-medium text-success-ink tabular-nums"
                      style={typography?.price}
                    >
                      <SignedAmount sign={MINUS} value={formatPrice(promotionDiscount)} />
                    </span>
                  </div>
                )}
                {loyaltyDiscount > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-success-ink" style={typography?.label}>
                      {t('Loyalty points', 'نقاط الولاء')}
                    </span>
                    <span
                      className="font-medium text-success-ink tabular-nums"
                      style={typography?.price}
                    >
                      <SignedAmount sign={MINUS} value={formatPrice(loyaltyDiscount)} />
                    </span>
                  </div>
                )}
              </>
            );
          })()}
          <div className="flex justify-between text-sm">
            <span
              className={`${summaryFontWeight} text-muted-foreground`}
              style={{ ...typography?.label, ...labelColorStyle }}
            >
              {t('Shipping', translations['Shipping'])}
            </span>
            <span
              className={`font-medium tabular-nums ${freeShipping ? 'text-success-ink' : ''}`}
              style={typography?.price}
            >
              {shippingToConfirm
                ? t('Set by the store', 'بيتحدد مع المتجر')
                : freeShipping || (shipping === 0 && shippingAreaChosen)
                  ? t('Free', translations['Free'])
                  : shipping > 0
                    ? formatPrice(shipping)
                    : t('Select area', 'اختر المنطقة')}
            </span>
          </div>
          {codFee > 0 && (
            <div className="flex justify-between text-sm" data-testid="summary-cod-fee">
              <span
                className={`${summaryFontWeight} text-muted-foreground`}
                style={{ ...typography?.label, ...labelColorStyle }}
              >
                {t('Cash on delivery fee', 'رسوم الدفع عند الاستلام')}
              </span>
              <span className="font-medium tabular-nums" style={typography?.price}>
                {formatPrice(codFee)}
              </span>
            </div>
          )}
          {tax > 0 && taxLabel && !taxIncludedInPrice && (
            <div className="flex justify-between text-sm">
              <span
                className={`${summaryFontWeight} text-muted-foreground`}
                style={{ ...typography?.label, ...labelColorStyle }}
              >
                {taxLabel}
              </span>
              <span className="font-medium tabular-nums" style={typography?.price}>
                {formatPrice(tax)}
              </span>
            </div>
          )}
          <div className="flex justify-between border-t pt-3">
            <span
              className={`text-lg ${summaryFontWeight} text-foreground`}
              style={{ ...typography?.heading, ...totalColorStyle }}
            >
              {t('Total', translations['Total'])}
            </span>
            <span
              className={`text-lg ${summaryFontWeight} text-primary tabular-nums`}
              style={{ ...typography?.price, ...totalColorStyle }}
            >
              {formatPrice(total)}
            </span>
          </div>
          {/* Tax already inside the listed price is informational only — a
              muted caption below Total, never a row in the summed amount
              column (a `total` that doesn't add it up would otherwise look
              like an on-screen arithmetic error). */}
          {tax > 0 && taxLabel && taxIncludedInPrice && (
            <p className="text-xs text-muted-foreground">
              {taxLabel} {'—'} {formatPrice(tax)}
            </p>
          )}
          {wallet && wallet.enabled && wallet.applied > 0 && (
            <>
              <div className="flex justify-between text-sm">
                <span className="text-success-ink" style={typography?.label}>
                  {t('Paid from wallet', 'مدفوع من المحفظة')}
                </span>
                <span
                  className="font-medium text-success-ink tabular-nums"
                  style={typography?.price}
                >
                  <SignedAmount sign={MINUS} value={formatPrice(wallet.applied)} />
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span
                  className={`${summaryFontWeight} text-foreground`}
                  style={{ ...typography?.label, ...labelColorStyle }}
                >
                  {t('Amount due', 'المبلغ المستحق')}
                </span>
                <span
                  className={`${summaryFontWeight} text-foreground tabular-nums`}
                  style={typography?.price}
                >
                  {formatPrice(Math.max(0, total - wallet.applied))}
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
