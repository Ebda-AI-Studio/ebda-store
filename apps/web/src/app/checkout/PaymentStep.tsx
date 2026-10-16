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

export default function PaymentStep({
  formData,
  shippingNames = {},
  onEditShipping,
  paymentProviders,
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
      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="font-medium text-foreground">{t('Shipping to', 'الشحن إلى')}</h3>
          <button
            type="button"
            onClick={onEditShipping}
            className="text-sm text-primary hover:underline"
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

      {/* Payment Methods. Not on a demo store (there is nothing to choose; the demo notice below
          is the answer), unless loading the methods failed: that error and its retry still show. */}
      {(!isDemo || paymentConfigError) && (
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-foreground">
            {t('Payment Method', translations['Payment Method'])}
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
                    'تعذّر تحميل طرق الدفع. يرجى التحقق من اتصالك وإعادة المحاولة.'
                  )}
                </span>
                {onRetryPaymentConfig && (
                  <button
                    type="button"
                    onClick={onRetryPaymentConfig}
                    className="flex-shrink-0 font-medium text-primary underline"
                  >
                    {t('Retry', 'إعادة المحاولة')}
                  </button>
                )}
              </div>
            ) : (
              paymentProviders.length === 0 && (
                <div
                  role="alert"
                  className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-foreground"
                >
                  {t(
                    'No payment methods are configured for this store. Please contact the store owner.',
                    'لا توجد طرق دفع مُعدّة لهذا المتجر. يرجى التواصل مع صاحب المتجر.'
                  )}
                </div>
              )
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
                  ? provider.descriptionAr || provider.description || defaultInfo?.description || ''
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

      <div className="flex justify-between">
        <button
          type="button"
          onClick={onEditShipping}
          className="text-sm text-primary hover:underline"
        >
          {language === 'ar' ? 'العودة إلى الشحن →' : '← Return to shipping'}
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
              ? t('Processing...', 'جاري المعالجة...')
              : selectedProvider === 'cod'
                ? t('Place Order', translations['Place Order'])
                : `${t('Pay', 'ادفع')} ${formatPrice(total)}`}
          </Button>
        )}
      </div>
    </div>
  );
}
