'use client';

import Image from 'next/image';
import { Button } from '@force/ui';
import { getPaymentIcon, DEFAULT_PAYMENT_PROVIDERS } from '../../components/PaymentIcons';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import type { PaymentProvider } from './types';

interface FormData {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  address: string;
  apartment: string;
  city: string;
  area: string;
  notes: string;
}

interface PaymentStepProps {
  checkoutError: string | null;
  onClearError: () => void;
  formData: FormData;
  onEditShipping: () => void;
  paymentProviders: PaymentProvider[];
  selectedProvider: string;
  onSelectProvider: (provider: string) => void;
  isProcessing: boolean;
  total: number;
  formatPrice: (fils: number) => string;
}

export default function PaymentStep({
  checkoutError,
  onClearError,
  formData,
  onEditShipping,
  paymentProviders,
  selectedProvider,
  onSelectProvider,
  isProcessing,
  total,
  formatPrice,
}: PaymentStepProps) {
  const { language, t } = useLanguage();

  return (
    <div className="space-y-6">
      {/* Checkout Error Display */}
      {checkoutError && (
        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 p-4">
          <div className="flex items-start gap-3">
            <svg
              className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <div className="flex-1">
              <h3 className="text-sm font-medium text-destructive">
                {t('Checkout Error', 'خطأ في الدفع')}
              </h3>
              <p className="mt-1 text-sm text-destructive">{checkoutError}</p>
            </div>
            <button
              type="button"
              onClick={onClearError}
              className="text-destructive hover:text-destructive/80"
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
        </div>
      )}

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
        <p className="mt-2 text-sm text-muted-foreground">
          {formData.firstName} {formData.lastName}
          <br />
          {formData.address}
          {formData.apartment && `, ${formData.apartment}`}
          <br />
          {formData.area}, {formData.city}
          <br />
          {formData.phone}
          <br />
          {formData.email}
        </p>
      </div>

      {/* Payment Methods */}
      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-foreground">
          {t('Payment Method', translations['Payment Method'])}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('Select your preferred payment method', 'اختر طريقة الدفع المفضلة')}
        </p>

        <div className="mt-6 space-y-3">
          {/* Render payment providers dynamically */}
          {(paymentProviders.length > 0 ? paymentProviders : DEFAULT_PAYMENT_PROVIDERS).map(
            provider => {
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
                      : 'border-border hover:border-border/80'
                  }`}
                >
                  <input
                    type="radio"
                    name="paymentMethod"
                    value={provider.id}
                    checked={selectedProvider === provider.id}
                    onChange={e => onSelectProvider(e.target.value)}
                    className="h-4 w-4 text-primary focus:ring-primary"
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
            }
          )}
        </div>
      </div>

      <div className="flex justify-between">
        <button
          type="button"
          onClick={onEditShipping}
          className="text-sm text-primary hover:underline"
        >
          {language === 'ar' ? 'العودة إلى الشحن →' : '← Return to shipping'}
        </button>
        <Button
          type="submit"
          size="lg"
          isLoading={isProcessing}
          disabled={!selectedProvider || isProcessing}
        >
          {isProcessing
            ? t('Processing...', 'جاري المعالجة...')
            : selectedProvider === 'cod'
              ? t('Place Order', translations['Place Order'])
              : `${t('Pay', 'ادفع')} ${formatPrice(total)}`}
        </Button>
      </div>
    </div>
  );
}
