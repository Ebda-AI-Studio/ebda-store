'use client';

import { useState, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Input, Select } from '@force/ui';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useCart } from '../../contexts/CartContext';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { api } from '../../lib/api';
import { trackInitiateCheckout } from '../../components/MarketingPixels';
import { isValidEmail } from '@force/shared';
import { OrderSummary } from './OrderSummary';

// Lazy-load the payment step component (includes PaymentIcons SVGs)
// so it is only fetched when the user advances past the shipping form.
const PaymentStep = dynamic(() => import('./PaymentStep'), {
  loading: () => (
    <div className="animate-pulse space-y-4">
      <div className="h-32 bg-muted rounded-xl" />
      <div className="h-48 bg-muted rounded-xl" />
    </div>
  ),
});
import { formatPrice } from '@/lib/format';
import type { CheckoutCartItem, Coupon, PaymentProvider } from './types';

interface Cart {
  id: string;
  items: CheckoutCartItem[];
  subtotal: number;
  total: number;
}

interface ShippingZone {
  id: string;
  name: string;
  nameAr: string | null;
  areas: string[];
  areasAr: string[];
  deliveryFee: number;
  freeShippingThreshold: number | null;
  estimatedDaysMin: number | null;
  estimatedDaysMax: number | null;
}

const KUWAIT_AREAS = [
  { en: 'Capital', ar: '\u0627\u0644\u0639\u0627\u0635\u0645\u0629' },
  { en: 'Hawalli', ar: '\u062d\u0648\u0644\u064a' },
  { en: 'Farwaniya', ar: '\u0627\u0644\u0641\u0631\u0648\u0627\u0646\u064a\u0629' },
  {
    en: 'Mubarak Al-Kabeer',
    ar: '\u0645\u0628\u0627\u0631\u0643 \u0627\u0644\u0643\u0628\u064a\u0631',
  },
  { en: 'Ahmadi', ar: '\u0627\u0644\u0623\u062d\u0645\u062f\u064a' },
  { en: 'Jahra', ar: '\u0627\u0644\u062c\u0647\u0631\u0627\u0621' },
];

export default function CheckoutClient() {
  const router = useRouter();
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { items: cartContextItems, total: cartContextTotal } = useCart();
  const { language, t } = useLanguage();
  const [step, setStep] = useState(1);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Server-side cart state used to reconcile with local cart context
  const [serverCart, setServerCart] = useState<Cart | null>(null);

  // Fire InitiateCheckout pixel event once cart items are available
  useEffect(() => {
    if (cartContextItems.length > 0) {
      trackInitiateCheckout({
        contentIds: cartContextItems.map(item => item.id),
        numItems: cartContextItems.reduce((sum, item) => sum + item.quantity, 0),
        value: cartContextTotal / 1000,
        currency: 'KWD',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run once on mount

  // Re-fetch the server-side cart on mount to ensure the displayed totals match
  // what the API will use when creating the order. If they differ, use the
  // server cart as the source of truth so the charged amount matches display.
  useEffect(() => {
    let cancelled = false;
    async function syncCart() {
      try {
        const result = await api.getCart();
        if (!cancelled && result.success && result.data?.cart) {
          setServerCart(result.data.cart);
        }
      } catch {
        // Non-critical -- fall back to local cart context
      }
    }
    syncCart();
    return () => {
      cancelled = true;
    };
  }, []);

  // Use server cart when available, otherwise fall back to local cart context.
  // This ensures the totals displayed to the user match the server-side values
  // that will be used to create the order and charge payment.
  const cart: Cart | null = serverCart
    ? serverCart
    : cartContextItems.length > 0
      ? {
          id: 'local-cart',
          items: cartContextItems.map(item => ({
            id: item.id,
            productId: item.id,
            quantity: item.quantity,
            price: item.price,
            product: {
              id: item.id,
              name: item.name,
              slug: item.slug,
              images: item.image ? [{ id: '1', url: item.image, alt: item.name }] : [],
            },
          })),
          subtotal: cartContextTotal,
          total: cartContextTotal,
        }
      : null;
  const [, setShippingZones] = useState<ShippingZone[]>([]);
  const [paymentProviders, setPaymentProviders] = useState<PaymentProvider[]>([]);

  // Shipping & discount
  const [selectedArea, setSelectedArea] = useState('');
  const [shippingCost, setShippingCost] = useState(0);
  const [freeShipping, setFreeShipping] = useState(false);
  const [couponCode, setCouponCode] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState<Coupon | null>(null);
  const [couponDiscount, setCouponDiscount] = useState(0);
  const [couponError, setCouponError] = useState('');

  // Payment
  const [selectedProvider, setSelectedProvider] = useState('');

  // Form data
  const [formData, setFormData] = useState({
    email: '',
    firstName: '',
    lastName: '',
    phone: '',
    address: '',
    apartment: '',
    city: '',
    area: '',
    notes: '',
  });

  // Form validation errors
  const [formErrors, setFormErrors] = useState<{
    email?: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    area?: string;
    address?: string;
    city?: string;
  }>({});

  // Checkout error state
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  // Fetch initial data (shipping zones and payment config)
  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      try {
        // Fetch shipping zones and payment config in parallel
        const [shippingResult, paymentResult] = await Promise.all([
          store?.id
            ? api.get<{ zones: ShippingZone[] }>(`/stores/public/${store.id}/shipping`)
            : Promise.resolve(null),
          api.get<{ providers: PaymentProvider[]; defaultProvider?: string }>('/payments/config'),
        ]);

        if (shippingResult?.success && shippingResult.data) {
          setShippingZones(shippingResult.data.zones || []);
        }

        if (paymentResult.success && paymentResult.data) {
          if (paymentResult.data.providers) {
            setPaymentProviders(paymentResult.data.providers);
            if (paymentResult.data.defaultProvider) {
              setSelectedProvider(paymentResult.data.defaultProvider);
            }
          }
        }
      } catch (error) {
        console.error('Failed to fetch checkout data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [store?.id]);

  // Calculate shipping when area changes
  const calculateShipping = useCallback(async () => {
    if (!selectedArea || !store?.id || !cart?.subtotal) return;

    try {
      const result = await api.post<{ shippingCost: number; freeShipping: boolean }>(
        `/stores/public/${store.id}/shipping/calculate`,
        { area: selectedArea, orderTotal: cart.subtotal }
      );
      if (result.success && result.data) {
        setShippingCost(result.data.shippingCost || 0);
        setFreeShipping(result.data.freeShipping || false);
      }
    } catch (error) {
      console.error('Failed to calculate shipping:', error);
    }
  }, [selectedArea, store?.id, cart?.subtotal]);

  useEffect(() => {
    calculateShipping();
  }, [calculateShipping]);

  const updateField = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (field === 'area') {
      setSelectedArea(value);
    }
    // Clear error when user starts typing
    if (formErrors[field as keyof typeof formErrors]) {
      setFormErrors(prev => ({ ...prev, [field]: undefined }));
    }
  };

  // Validate form data
  const validateForm = (): boolean => {
    const errors: typeof formErrors = {};

    // Email validation
    if (!formData.email.trim()) {
      errors.email = t('Email is required', 'البريد الإلكتروني مطلوب');
    } else if (!isValidEmail(formData.email)) {
      errors.email = t('Please enter a valid email address', 'يرجى إدخال بريد إلكتروني صحيح');
    }

    // First name validation
    if (!formData.firstName.trim()) {
      errors.firstName = t('First name is required', 'الاسم الأول مطلوب');
    } else if (formData.firstName.trim().length < 2) {
      errors.firstName = t(
        'First name must be at least 2 characters',
        'الاسم الأول يجب أن يكون حرفين على الأقل'
      );
    }

    // Last name validation
    if (!formData.lastName.trim()) {
      errors.lastName = t('Last name is required', 'الاسم الأخير مطلوب');
    } else if (formData.lastName.trim().length < 2) {
      errors.lastName = t(
        'Last name must be at least 2 characters',
        'الاسم الأخير يجب أن يكون حرفين على الأقل'
      );
    }

    // Phone validation (Kuwait format)
    if (!formData.phone.trim()) {
      errors.phone = t('Phone number is required', 'رقم الهاتف مطلوب');
    } else {
      // Remove spaces, dashes and plus sign for validation
      const cleanPhone = formData.phone.replace(/[\s\-+]/g, '');
      // Kuwait numbers: 965 + 8 digits OR just 8 digits starting with 5,6,9
      if (!/^(965)?[569]\d{7}$/.test(cleanPhone)) {
        errors.phone = t(
          'Please enter a valid Kuwait phone number',
          'يرجى إدخال رقم هاتف كويتي صحيح'
        );
      }
    }

    // Area validation
    if (!formData.area) {
      errors.area = t('Please select a delivery area', 'يرجى اختيار منطقة التوصيل');
    }

    // Address validation
    if (!formData.address.trim()) {
      errors.address = t('Block & Street address is required', 'عنوان القطعة والشارع مطلوب');
    } else if (formData.address.trim().length < 5) {
      errors.address = t('Please enter a complete address', 'يرجى إدخال عنوان كامل');
    }

    // City validation (optional but recommended)
    if (!formData.city.trim()) {
      errors.city = t('City is required', 'المدينة مطلوبة');
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Apply coupon
  const handleApplyCoupon = async () => {
    if (!couponCode.trim() || !store?.id || !cart) return;

    setCouponError('');
    try {
      const result = await api.post<{ coupon: Coupon; discount: number }>(
        `/stores/public/${store.id}/coupons/validate`,
        { code: couponCode, orderTotal: cart.subtotal }
      );
      if (result.success && result.data) {
        setAppliedCoupon(result.data.coupon);
        setCouponDiscount(result.data.discount);
        if (result.data.coupon.type === 'free_shipping') {
          setFreeShipping(true);
          setShippingCost(0);
        }
      } else {
        setCouponError(result.error?.message || t('Invalid coupon', 'كوبون غير صالح'));
      }
    } catch {
      setCouponError(t('Failed to apply coupon', 'فشل تطبيق الكوبون'));
    }
  };

  const removeCoupon = () => {
    setAppliedCoupon(null);
    setCouponDiscount(0);
    setCouponCode('');
    calculateShipping();
  };

  // Calculate totals
  const subtotal = cart?.subtotal || 0;
  const discount = couponDiscount;
  const shipping = freeShipping ? 0 : shippingCost;
  const total = subtotal - discount + shipping;

  // Submit order
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (step === 1) {
      // Validate before proceeding to payment
      if (!validateForm()) {
        // Scroll to first error
        const firstError = document.querySelector('[data-error="true"]');
        firstError?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      setStep(2);
      return;
    }

    setIsProcessing(true);
    setCheckoutError(null);

    try {
      // Create order
      const orderResult = await api.createOrder({
        shippingAddress: {
          firstName: formData.firstName,
          lastName: formData.lastName,
          address1: formData.address,
          address2: formData.apartment,
          city: formData.city,
          state: formData.area,
          postalCode: '',
          country: 'KW',
          phone: formData.phone,
        },
        paymentMethod: selectedProvider,
        notes: formData.notes,
      });

      if (!orderResult.success || !orderResult.data?.order) {
        throw new Error(orderResult.error?.message || 'Failed to create order');
      }

      const order = orderResult.data.order;

      // Create payment
      const paymentResult = await api.post<{ paymentUrl?: string }>('/payments/create', {
        orderId: order.id,
        provider: selectedProvider,
        successUrl: `${window.location.origin}/checkout/success?orderId=${order.id}`,
        errorUrl: `${window.location.origin}/checkout/error?orderId=${order.id}`,
      });

      if (paymentResult.success && paymentResult.data?.paymentUrl) {
        // Redirect to payment gateway
        window.location.href = paymentResult.data.paymentUrl;
      } else if (selectedProvider === 'cod') {
        // Cash on delivery - go straight to success
        router.push(storeUrl(`/checkout/success?orderId=${order.id}`));
      } else {
        throw new Error(paymentResult.error?.message || 'Failed to initiate payment');
      }
    } catch (error) {
      console.error('Checkout error:', error);
      setCheckoutError(
        error instanceof Error ? error.message : 'An unexpected error occurred. Please try again.'
      );
      setIsProcessing(false);
    }
  };

  if (isLoading) {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
          <p className="text-sm text-muted-foreground">
            {t('Loading checkout...', 'جارٍ التحميل...')}
          </p>
        </div>
      </main>
    );
  }

  if (!cart || cart.items.length === 0) {
    return (
      <main className="min-h-screen bg-background">
        <div className="mx-auto max-w-7xl px-4 py-16 text-center">
          <h1 className="text-2xl font-bold text-foreground">
            {t('Your cart is empty', translations['Your cart is empty'])}
          </h1>
          <p className="mt-2 text-muted-foreground">
            {t(
              'Add some products before checking out.',
              '\u0623\u0636\u0641 \u0628\u0639\u0636 \u0627\u0644\u0645\u0646\u062a\u062c\u0627\u062a \u0642\u0628\u0644 \u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062f\u0641\u0639.'
            )}
          </p>
          <Link href={storeUrl('/products')}>
            <Button className="mt-6">
              {t('Continue Shopping', translations['Continue Shopping'])}
            </Button>
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background">
      {/* Navigation */}
      <nav className="border-b bg-background" aria-label="Checkout">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link href={storeUrl('/')} className="flex items-center gap-2">
            {store?.logo ? (
              <Image
                src={store.logo}
                alt={store.name}
                width={40}
                height={30}
                className="object-contain"
              />
            ) : (
              <span className="text-xl font-bold text-primary">{store?.name || 'Store'}</span>
            )}
          </Link>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
              />
            </svg>
            {t('Secure Checkout', '\u062f\u0641\u0639 \u0622\u0645\u0646')}
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Progress Steps */}
        <div className="mb-8">
          <div className="flex items-center justify-center">
            {/* Step 1: Shipping -- clickable when user is on step 2 (completed step) */}
            <button
              type="button"
              onClick={() => {
                if (step > 1) setStep(1);
              }}
              disabled={step <= 1}
              className={`flex items-center ${step > 1 ? 'cursor-pointer group' : 'cursor-default'}`}
            >
              <div
                className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${step >= 1 ? 'bg-primary text-white' : 'bg-muted text-muted-foreground'} ${step > 1 ? 'group-hover:bg-primary/80' : ''}`}
              >
                {step > 1 ? (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                ) : (
                  1
                )}
              </div>
              <span
                className={`ml-2 text-sm font-medium transition-colors ${step >= 1 ? 'text-foreground' : 'text-muted-foreground'} ${step > 1 ? 'group-hover:text-primary' : ''}`}
              >
                {t('Shipping', translations['Shipping'])}
              </span>
            </button>
            <div className={`mx-4 h-0.5 w-16 ${step >= 2 ? 'bg-primary' : 'bg-muted'}`} />
            {/* Step 2: Payment -- current or future step, not clickable */}
            <div className="flex items-center">
              <div
                className={`flex h-8 w-8 items-center justify-center rounded-full ${step >= 2 ? 'bg-primary text-white' : 'bg-muted text-muted-foreground'}`}
              >
                2
              </div>
              <span
                className={`ml-2 text-sm font-medium ${step >= 2 ? 'text-foreground' : 'text-muted-foreground'}`}
              >
                {t('Payment', '\u0627\u0644\u062f\u0641\u0639')}
              </span>
            </div>
          </div>
        </div>

        <div className="lg:grid lg:grid-cols-12 lg:gap-8">
          {/* Form */}
          <div className="lg:col-span-7">
            <form onSubmit={handleSubmit}>
              {step === 1 && (
                <div className="rounded-xl border bg-card p-6 shadow-sm">
                  <h2 className="text-lg font-semibold text-foreground">
                    {t(
                      'Shipping Information',
                      '\u0645\u0639\u0644\u0648\u0645\u0627\u062a \u0627\u0644\u0634\u062d\u0646'
                    )}
                  </h2>

                  <div className="mt-6 space-y-4">
                    <div data-error={!!formErrors.email}>
                      <Input
                        label={t(
                          'Email address',
                          '\u0627\u0644\u0628\u0631\u064a\u062f \u0627\u0644\u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a'
                        )}
                        type="email"
                        value={formData.email}
                        onChange={e => updateField('email', e.target.value)}
                        className={
                          formErrors.email
                            ? 'border-destructive focus:border-destructive focus:ring-destructive'
                            : ''
                        }
                      />
                      {formErrors.email && (
                        <p role="alert" className="mt-1 text-sm text-destructive">
                          {formErrors.email}
                        </p>
                      )}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div data-error={!!formErrors.firstName}>
                        <Input
                          label={t(
                            'First name',
                            '\u0627\u0644\u0627\u0633\u0645 \u0627\u0644\u0623\u0648\u0644'
                          )}
                          value={formData.firstName}
                          onChange={e => updateField('firstName', e.target.value)}
                          className={
                            formErrors.firstName
                              ? 'border-destructive focus:border-destructive focus:ring-destructive'
                              : ''
                          }
                        />
                        {formErrors.firstName && (
                          <p role="alert" className="mt-1 text-sm text-destructive">
                            {formErrors.firstName}
                          </p>
                        )}
                      </div>
                      <div data-error={!!formErrors.lastName}>
                        <Input
                          label={t(
                            'Last name',
                            '\u0627\u0633\u0645 \u0627\u0644\u0639\u0627\u0626\u0644\u0629'
                          )}
                          value={formData.lastName}
                          onChange={e => updateField('lastName', e.target.value)}
                          className={
                            formErrors.lastName
                              ? 'border-destructive focus:border-destructive focus:ring-destructive'
                              : ''
                          }
                        />
                        {formErrors.lastName && (
                          <p role="alert" className="mt-1 text-sm text-destructive">
                            {formErrors.lastName}
                          </p>
                        )}
                      </div>
                    </div>

                    <div data-error={!!formErrors.phone}>
                      <Input
                        label={t('Phone', translations['Phone'])}
                        type="tel"
                        placeholder="+965 XXXX XXXX"
                        value={formData.phone}
                        onChange={e => updateField('phone', e.target.value)}
                        className={
                          formErrors.phone
                            ? 'border-destructive focus:border-destructive focus:ring-destructive'
                            : ''
                        }
                      />
                      {formErrors.phone && (
                        <p role="alert" className="mt-1 text-sm text-destructive">
                          {formErrors.phone}
                        </p>
                      )}
                    </div>

                    <div data-error={!!formErrors.area}>
                      <Select
                        label={t(
                          'Delivery Area',
                          '\u0645\u0646\u0637\u0642\u0629 \u0627\u0644\u062a\u0648\u0635\u064a\u0644'
                        )}
                        value={formData.area}
                        onChange={e => updateField('area', e.target.value)}
                        options={[
                          {
                            value: '',
                            label: t(
                              'Select area...',
                              '\u0627\u062e\u062a\u0631 \u0627\u0644\u0645\u0646\u0637\u0642\u0629...'
                            ),
                          },
                          ...KUWAIT_AREAS.map(a => ({
                            value: a.en,
                            label: language === 'ar' ? `${a.ar} / ${a.en}` : `${a.en} / ${a.ar}`,
                          })),
                        ]}
                        className={
                          formErrors.area
                            ? 'border-destructive focus:border-destructive focus:ring-destructive'
                            : ''
                        }
                      />
                      {formErrors.area && (
                        <p role="alert" className="mt-1 text-sm text-destructive">
                          {formErrors.area}
                        </p>
                      )}
                    </div>

                    <div data-error={!!formErrors.address}>
                      <Input
                        label={t(
                          'Block & Street',
                          '\u0627\u0644\u0642\u0637\u0639\u0629 \u0648\u0627\u0644\u0634\u0627\u0631\u0639'
                        )}
                        value={formData.address}
                        onChange={e => updateField('address', e.target.value)}
                        className={
                          formErrors.address
                            ? 'border-destructive focus:border-destructive focus:ring-destructive'
                            : ''
                        }
                      />
                      {formErrors.address && (
                        <p role="alert" className="mt-1 text-sm text-destructive">
                          {formErrors.address}
                        </p>
                      )}
                    </div>

                    <Input
                      label={t(
                        'Building / House / Apartment',
                        '\u0627\u0644\u0645\u0628\u0646\u0649 / \u0627\u0644\u0645\u0646\u0632\u0644 / \u0627\u0644\u0634\u0642\u0629'
                      )}
                      value={formData.apartment}
                      onChange={e => updateField('apartment', e.target.value)}
                    />

                    <div data-error={!!formErrors.city}>
                      <Input
                        label={t('City', '\u0627\u0644\u0645\u062f\u064a\u0646\u0629')}
                        value={formData.city}
                        onChange={e => updateField('city', e.target.value)}
                        placeholder={t(
                          'e.g., Kuwait City',
                          '\u0645\u062b\u0627\u0644: \u0645\u062f\u064a\u0646\u0629 \u0627\u0644\u0643\u0648\u064a\u062a'
                        )}
                        className={
                          formErrors.city
                            ? 'border-destructive focus:border-destructive focus:ring-destructive'
                            : ''
                        }
                      />
                      {formErrors.city && (
                        <p role="alert" className="mt-1 text-sm text-destructive">
                          {formErrors.city}
                        </p>
                      )}
                    </div>

                    <div>
                      <label
                        htmlFor="order-notes"
                        className="block text-sm font-medium text-foreground mb-1"
                      >
                        {t(
                          'Order Notes (optional)',
                          '\u0645\u0644\u0627\u062d\u0638\u0627\u062a \u0627\u0644\u0637\u0644\u0628 (\u0627\u062e\u062a\u064a\u0627\u0631\u064a)'
                        )}
                      </label>
                      <textarea
                        id="order-notes"
                        value={formData.notes}
                        onChange={e => updateField('notes', e.target.value)}
                        rows={3}
                        className="w-full rounded-lg border border-border px-4 py-2 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary"
                        placeholder={t(
                          'Any special delivery instructions...',
                          '\u0623\u064a \u062a\u0639\u0644\u064a\u0645\u0627\u062a \u062e\u0627\u0635\u0629 \u0644\u0644\u062a\u0648\u0635\u064a\u0644...'
                        )}
                      />
                    </div>
                  </div>

                  <div className="mt-6 flex justify-between">
                    <Link href={storeUrl('/cart')} className="text-sm text-primary hover:underline">
                      {language === 'ar'
                        ? '\u0627\u0644\u0639\u0648\u062f\u0629 \u0625\u0644\u0649 \u0627\u0644\u0633\u0644\u0629 \u2192'
                        : '\u2190 Return to cart'}
                    </Link>
                    <Button type="submit">
                      {t(
                        'Continue to Payment',
                        '\u0627\u0644\u0645\u062a\u0627\u0628\u0639\u0629 \u0644\u0644\u062f\u0641\u0639'
                      )}
                    </Button>
                  </div>
                </div>
              )}

              {step === 2 && (
                <PaymentStep
                  checkoutError={checkoutError}
                  onClearError={() => setCheckoutError(null)}
                  formData={formData}
                  onEditShipping={() => setStep(1)}
                  paymentProviders={paymentProviders}
                  selectedProvider={selectedProvider}
                  onSelectProvider={setSelectedProvider}
                  isProcessing={isProcessing}
                  total={total}
                  formatPrice={formatPrice}
                />
              )}
            </form>
          </div>

          {/* Order Summary */}
          <OrderSummary
            items={cart.items}
            subtotal={subtotal}
            discount={discount}
            shipping={shipping}
            total={total}
            freeShipping={freeShipping}
            couponCode={couponCode}
            onCouponCodeChange={setCouponCode}
            appliedCoupon={appliedCoupon}
            onApplyCoupon={handleApplyCoupon}
            onRemoveCoupon={removeCoupon}
            couponError={couponError}
          />
        </div>
      </div>
    </main>
  );
}
