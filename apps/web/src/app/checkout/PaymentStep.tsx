'use client';

import Image from 'next/image';
import { Button } from '@ebda/ui';
import { getPaymentIcon, DEFAULT_PAYMENT_PROVIDERS } from '../../components/PaymentIcons';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import type { PaymentProvider } from './types';
import { DemoCheckoutNotice } from '../../components/demo/DemoCheckoutNotice';
import {
  shippingSummaryLines,
  type LocalizedPlace,
  type ShippingSummaryForm,
} from './_lib/shippingSummary';

type FormData = ShippingSummaryForm & { notes?: string };

interface PaymentStepProps {
  formData: FormData;
  /** IA-01: the localized area / governorate names for the review (canonical value if absent). */
  shippingNames?: { area?: LocalizedPlace; governorate?: LocalizedPlace };
  onEditShipping: () => void;
  paymentProviders: PaymentProvider[];
  /** Gold cart, prepaid-only store, and every offered method was a deferred one: say it has to be paid online. */
  goldNeedsOnlinePayment?: boolean;
  /** True when the payment-config request FAILED (vs. genuinely returned none). */
  paymentConfigError?: boolean;
  /** Re-run the checkout data load. */
  onRetryPaymentConfig?: () => void;
  selectedProvider: string;
  onSelectProvider: (provider: string) => void;
  isProcessing: boolean;
  total: number;
  formatPrice: (piastres: number) => string;
  /**
   * Per-store opt-in delivery block (info note + delivery-window picker).
   * Rendered immediately above the Pay button in every state — passed in as
   * a node rather than built here so CheckoutClient owns the availability
   * computation + selection state. Undefined/null when the store hasn't
   * enabled either part.
   */
  deliverySection?: React.ReactNode;
  /**
   * Defense-in-depth: true when the store's minimum order value isn't met
   * (the cart page / checkout step 1 guards should already have kept the
   * customer from reaching this step, but a direct navigation or stale tab
   * could). Disables the Pay button; `checkoutError` carries the message.
   */
  belowMinimumOrder?: boolean;
  /** Demo store: the pay action is replaced by a notice (the API refuses the order too). */
  isDemo?: boolean;
}

/**
 * A store with delivery dates / windows: on a wide screen the payment card and the delivery card sit
 * side by side, so "Place order" stays inside the first 800px of a 1280 window (taste P2: the date row
 * pushed it below the fold). A store with no delivery block gets no wrapper element (markup unchanged).
 */
function PaymentAndDelivery({ paired, children }: { paired: boolean; children: React.ReactNode }) {
  return paired ? (
    <div className="space-y-6 lg:grid lg:grid-cols-2 lg:items-start lg:gap-6 lg:space-y-0">
      {children}
    </div>
  ) : (
    <>{children}</>
  );
}

export default function PaymentStep({
  formData,
  shippingNames = {},
  onEditShipping,
  paymentProviders,
  goldNeedsOnlinePayment = false,
  paymentConfigError = false,
  onRetryPaymentConfig,
  selectedProvider,
  onSelectProvider,
  isProcessing,
  total,
  formatPrice,
  deliverySection,
  belowMinimumOrder = false,
  isDemo = false,
}: PaymentStepProps) {
  const { language, t } = useLanguage();

  return (
    <div className="space-y-6">
      {/* The checkout error banner used to live here. It moved to
          CheckoutClient's <CheckoutErrorAlert>, because several error cases
          call setStep(1) — which unmounts this component and with it the only
          thing that could show the message. See that component's header. */}

      {/* Shipping Summary */}
      <div className="rounded-[var(--radius)] border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-foreground">{t('Shipping to', 'الشحن إلى')}</h2>
          <button
            type="button"
            onClick={onEditShipping}
            className="inline-flex min-h-11 min-w-11 items-center justify-center text-sm text-primary underline underline-offset-4"
          >
            {t('Edit', 'تعديل')}
          </button>
        </div>
        <p data-testid="shipping-summary" className="mt-2 text-sm text-muted-foreground">
          {shippingSummaryLines(formData, shippingNames, language === 'ar' ? 'ar' : 'en').map(
            (line, i) => (
              <span key={i} className="block">
                {line}
              </span>
            )
          )}
        </p>
      </div>

      <PaymentAndDelivery paired={Boolean(deliverySection)}>
        {/* Payment Methods. Not on a demo store (there is nothing to choose; the demo notice below
          is the answer), unless loading the methods failed: that error and its retry still show. */}
        {(!isDemo || paymentConfigError) && (
          <div className="rounded-[var(--radius)] border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-foreground">
              {t('Payment method', translations['Payment Method'])}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('Select your preferred payment method', 'اختر طريقة الدفع المفضلة')}
            </p>

            <div className="mt-6 space-y-3">
              {paymentConfigError ? (
                <div
                  role="alert"
                  className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-foreground"
                >
                  <span>
                    {t(
                      "Couldn't load payment methods. Please check your connection and retry.",
                      'معرفناش نحمّل طرق الدفع. اتأكد من اتصالك وجرّب تاني.'
                    )}
                  </span>
                  {onRetryPaymentConfig && (
                    <button
                      type="button"
                      onClick={onRetryPaymentConfig}
                      className="inline-flex min-h-11 min-w-11 flex-shrink-0 items-center justify-center font-medium text-primary underline"
                    >
                      {t('Retry', 'إعادة المحاولة')}
                    </button>
                  )}
                </div>
              ) : (
                paymentProviders.length === 0 &&
                (goldNeedsOnlinePayment ? (
                  <div
                    role="alert"
                    className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-foreground"
                  >
                    {t(
                      'This order has to be paid online. This store has no online payment method set up yet, so please contact the store owner.',
                      'الطلب ده لازم يتدفع أونلاين. المتجر لسه معندوش طريقة دفع أونلاين متظبطة، كلّم صاحب المتجر.'
                    )}
                  </div>
                ) : (
                  <div
                    role="alert"
                    className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-foreground"
                  >
                    {t(
                      'No payment methods are configured for this store. Please contact the store owner.',
                      'مفيش طرق دفع متظبطة للمتجر ده. كلّم صاحب المتجر.'
                    )}
                  </div>
                ))
              )}
              {/* Render payment providers dynamically. We never fall back to
              DEFAULT_PAYMENT_PROVIDERS here — that list was a visual mock
              and showed payment options the backend would 400 on. */}
              {paymentProviders.map(provider => {
                // Get display info - use API data or fallback to defaults
                const defaultInfo = DEFAULT_PAYMENT_PROVIDERS.find(p => p.id === provider.id);
                const displayName =
                  language === 'ar'
                    ? provider.nameAr || provider.name || defaultInfo?.name || provider.id
                    : provider.name || defaultInfo?.name || provider.id;
                const displayDescription =
                  language === 'ar'
                    ? provider.descriptionAr ||
                      provider.description ||
                      defaultInfo?.description ||
                      ''
                    : provider.description || defaultInfo?.description || '';

                return (
                  <label
                    key={provider.id}
                    className={`flex items-center gap-4 rounded-lg border p-4 cursor-pointer transition ${
                      selectedProvider === provider.id
                        ? 'border-primary bg-primary/5'
                        : 'border-input hover:border-input/80'
                    }`}
                  >
                    <input
                      type="radio"
                      name="paymentMethod"
                      value={provider.id}
                      checked={selectedProvider === provider.id}
                      onChange={e => onSelectProvider(e.target.value)}
                      className="h-5 w-5 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <div className="flex-1">
                      <span className="font-medium text-foreground">{displayName}</span>
                      {displayDescription && (
                        <p className="text-sm text-muted-foreground">{displayDescription}</p>
                      )}
                    </div>
                    {/* Render icon from logo URL or use default icon */}
                    {provider.logo ? (
                      <div className="flex h-8 w-12 items-center justify-center">
                        <Image
                          src={provider.logo}
                          alt={displayName}
                          width={48}
                          height={32}
                          className="object-contain"
                        />
                      </div>
                    ) : (
                      getPaymentIcon(provider.id)
                    )}
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {/* Delivery block (info note + window picker) — always immediately
          above the Pay button, in every state. */}
        {deliverySection}
      </PaymentAndDelivery>

      <div className="flex justify-between">
        <button
          type="button"
          onClick={onEditShipping}
          className="inline-flex min-h-11 min-w-11 items-center gap-1.5 text-sm text-primary underline underline-offset-4"
        >
          <svg
            className="h-4 w-4 shrink-0 rtl:-scale-x-100"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10 19l-7-7m0 0l7-7m-7 7h18"
            />
          </svg>
          {t('Return to shipping', 'العودة إلى الشحن')}
        </button>
        {isDemo ? (
          <DemoCheckoutNotice />
        ) : (
          <Button
            type="submit"
            size="lg"
            isLoading={isProcessing}
            disabled={!selectedProvider || isProcessing || belowMinimumOrder}
          >
            {isProcessing
              ? t('Processing...', 'بنكمّل الدفع...')
              : selectedProvider === 'cod'
                ? // IA-13 (W4): the confirm button carries the total, like the sticky cart bar.
                  `${t('Place order', 'تأكيد الطلب')} · ${formatPrice(total)}`
                : `${t('Pay', 'ادفع')} ${formatPrice(total)}`}
          </Button>
        )}
      </div>
    </div>
  );
}
