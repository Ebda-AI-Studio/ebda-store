'use client';

import { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Input, Select } from '@force/ui';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useCart } from '../../contexts/CartContext';
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { api } from '../../lib/api';
import { getPaymentIcon, DEFAULT_PAYMENT_PROVIDERS } from '../../components/PaymentIcons';
import { trackInitiateCheckout } from '../../components/MarketingPixels';

interface CartItem {
  id: string;
  productId: string;
  quantity: number;
  price: number;
  product: {
    id: string;
    name: string;
    slug: string;
    images: { id: string; url: string; alt?: string }[];
  };
}

interface Cart {
  id: string;
  items: CartItem[];
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

interface PaymentProvider {
  id: string;
  name: string;
  nameAr?: string;
  description?: string;
  descriptionAr?: string;
  logo?: string;
  methods?: string[];
  enabled?: boolean;
}

interface Coupon {
  id: string;
  code: string;
  name: string;
  type: 'percentage' | 'fixed' | 'free_shipping';
  value: number;
}

const KUWAIT_AREAS = [
  { en: 'Capital', ar: 'العاصمة' },
  { en: 'Hawalli', ar: 'حولي' },
  { en: 'Farwaniya', ar: 'الفروانية' },
  { en: 'Mubarak Al-Kabeer', ar: 'مبارك الكبير' },
  { en: 'Ahmadi', ar: 'الأحمدي' },
  { en: 'Jahra', ar: 'الجهراء' },
];

function formatPrice(fils: number) {
  return `${(fils / 1000).toFixed(3)} KWD`;
}

export default function CheckoutPage() {
  const router = useRouter();
  const { store } = useStore();
  const storeUrl = useStoreUrl();
  const { items: cartContextItems, total: cartContextTotal } = useCart();
  const { language, t } = useLanguage();
  const [step, setStep] = useState(1);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

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

  // Convert CartContext items to the format checkout expects
  const cart: Cart | null =
    cartContextItems.length > 0
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
        // Fetch shipping zones
        if (store?.id) {
          const shippingRes = await fetch(
            `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1'}/stores/public/${store.id}/shipping`
          );
          if (shippingRes.ok) {
            const shippingData = await shippingRes.json();
            setShippingZones(shippingData.data?.zones || []);
          }
        }

        // Fetch payment config
        const paymentRes = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1'}/payments/config`
        );
        if (paymentRes.ok) {
          const paymentData = await paymentRes.json();
          if (paymentData.data?.providers) {
            setPaymentProviders(paymentData.data.providers);
            if (paymentData.data.defaultProvider) {
              setSelectedProvider(paymentData.data.defaultProvider);
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
    if (!selectedArea || !store?.id || !cart) return;

    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1'}/stores/public/${store.id}/shipping/calculate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ area: selectedArea, orderTotal: cart.subtotal }),
        }
      );
      if (res.ok) {
        const data = await res.json();
        setShippingCost(data.data?.shippingCost || 0);
        setFreeShipping(data.data?.freeShipping || false);
      }
    } catch (error) {
      console.error('Failed to calculate shipping:', error);
    }
  }, [selectedArea, store?.id, cart]);

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
      errors.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      errors.email = 'Please enter a valid email address';
    }

    // First name validation
    if (!formData.firstName.trim()) {
      errors.firstName = 'First name is required';
    } else if (formData.firstName.trim().length < 2) {
      errors.firstName = 'First name must be at least 2 characters';
    }

    // Last name validation
    if (!formData.lastName.trim()) {
      errors.lastName = 'Last name is required';
    } else if (formData.lastName.trim().length < 2) {
      errors.lastName = 'Last name must be at least 2 characters';
    }

    // Phone validation (Kuwait format)
    if (!formData.phone.trim()) {
      errors.phone = 'Phone number is required';
    } else {
      // Remove spaces, dashes and plus sign for validation
      const cleanPhone = formData.phone.replace(/[\s\-+]/g, '');
      // Kuwait numbers: 965 + 8 digits OR just 8 digits starting with 5,6,9
      if (!/^(965)?[569]\d{7}$/.test(cleanPhone)) {
        errors.phone = 'Please enter a valid Kuwait phone number';
      }
    }

    // Area validation
    if (!formData.area) {
      errors.area = 'Please select a delivery area';
    }

    // Address validation
    if (!formData.address.trim()) {
      errors.address = 'Block & Street address is required';
    } else if (formData.address.trim().length < 5) {
      errors.address = 'Please enter a complete address';
    }

    // City validation (optional but recommended)
    if (!formData.city.trim()) {
      errors.city = 'City is required';
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Apply coupon
  const handleApplyCoupon = async () => {
    if (!couponCode.trim() || !store?.id || !cart) return;

    setCouponError('');
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1'}/stores/public/${store.id}/coupons/validate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: couponCode, orderTotal: cart.subtotal }),
        }
      );
      const data = await res.json();
      if (res.ok && data.success) {
        setAppliedCoupon(data.data.coupon);
        setCouponDiscount(data.data.discount);
        if (data.data.coupon.type === 'free_shipping') {
          setFreeShipping(true);
          setShippingCost(0);
        }
      } else {
        setCouponError(data.error?.message || 'Invalid coupon');
      }
    } catch {
      setCouponError('Failed to apply coupon');
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
      const token = localStorage.getItem('accessToken');
      const paymentRes = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1'}/payments/create`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            orderId: order.id,
            provider: selectedProvider,
            successUrl: `${window.location.origin}/checkout/success?orderId=${order.id}`,
            errorUrl: `${window.location.origin}/checkout/error?orderId=${order.id}`,
          }),
        }
      );

      const paymentData = await paymentRes.json();

      if (paymentRes.ok && paymentData.data?.paymentUrl) {
        // Redirect to payment gateway
        window.location.href = paymentData.data.paymentUrl;
      } else if (selectedProvider === 'cod') {
        // Cash on delivery - go straight to success
        router.push(storeUrl(`/checkout/success?orderId=${order.id}`));
      } else {
        throw new Error(paymentData.error?.message || 'Failed to initiate payment');
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
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
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
            {t('Add some products before checking out.', 'أضف بعض المنتجات قبل إتمام الدفع.')}
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
      <nav className="border-b bg-background">
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
            {t('Secure Checkout', 'دفع آمن')}
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Progress Steps */}
        <div className="mb-8">
          <div className="flex items-center justify-center">
            <div className="flex items-center">
              <div
                className={`flex h-8 w-8 items-center justify-center rounded-full ${step >= 1 ? 'bg-primary text-white' : 'bg-muted text-muted-foreground'}`}
              >
                1
              </div>
              <span
                className={`ml-2 text-sm font-medium ${step >= 1 ? 'text-foreground' : 'text-muted-foreground'}`}
              >
                {t('Shipping', translations['Shipping'])}
              </span>
            </div>
            <div className={`mx-4 h-0.5 w-16 ${step >= 2 ? 'bg-primary' : 'bg-muted'}`} />
            <div className="flex items-center">
              <div
                className={`flex h-8 w-8 items-center justify-center rounded-full ${step >= 2 ? 'bg-primary text-white' : 'bg-muted text-muted-foreground'}`}
              >
                2
              </div>
              <span
                className={`ml-2 text-sm font-medium ${step >= 2 ? 'text-foreground' : 'text-muted-foreground'}`}
              >
                {t('Payment', 'الدفع')}
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
                    {t('Shipping Information', 'معلومات الشحن')}
                  </h2>

                  <div className="mt-6 space-y-4">
                    <div data-error={!!formErrors.email}>
                      <Input
                        label={t('Email address', 'البريد الإلكتروني')}
                        type="email"
                        value={formData.email}
                        onChange={e => updateField('email', e.target.value)}
                        className={
                          formErrors.email
                            ? 'border-red-500 focus:border-red-500 focus:ring-red-500'
                            : ''
                        }
                      />
                      {formErrors.email && (
                        <p className="mt-1 text-sm text-red-500">{formErrors.email}</p>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div data-error={!!formErrors.firstName}>
                        <Input
                          label={t('First name', 'الاسم الأول')}
                          value={formData.firstName}
                          onChange={e => updateField('firstName', e.target.value)}
                          className={
                            formErrors.firstName
                              ? 'border-red-500 focus:border-red-500 focus:ring-red-500'
                              : ''
                          }
                        />
                        {formErrors.firstName && (
                          <p className="mt-1 text-sm text-red-500">{formErrors.firstName}</p>
                        )}
                      </div>
                      <div data-error={!!formErrors.lastName}>
                        <Input
                          label={t('Last name', 'اسم العائلة')}
                          value={formData.lastName}
                          onChange={e => updateField('lastName', e.target.value)}
                          className={
                            formErrors.lastName
                              ? 'border-red-500 focus:border-red-500 focus:ring-red-500'
                              : ''
                          }
                        />
                        {formErrors.lastName && (
                          <p className="mt-1 text-sm text-red-500">{formErrors.lastName}</p>
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
                            ? 'border-red-500 focus:border-red-500 focus:ring-red-500'
                            : ''
                        }
                      />
                      {formErrors.phone && (
                        <p className="mt-1 text-sm text-red-500">{formErrors.phone}</p>
                      )}
                    </div>

                    <div data-error={!!formErrors.area}>
                      <Select
                        label={t('Delivery Area', 'منطقة التوصيل')}
                        value={formData.area}
                        onChange={e => updateField('area', e.target.value)}
                        options={[
                          { value: '', label: t('Select area...', 'اختر المنطقة...') },
                          ...KUWAIT_AREAS.map(a => ({
                            value: a.en,
                            label: language === 'ar' ? `${a.ar} / ${a.en}` : `${a.en} / ${a.ar}`,
                          })),
                        ]}
                        className={
                          formErrors.area
                            ? 'border-red-500 focus:border-red-500 focus:ring-red-500'
                            : ''
                        }
                      />
                      {formErrors.area && (
                        <p className="mt-1 text-sm text-red-500">{formErrors.area}</p>
                      )}
                    </div>

                    <div data-error={!!formErrors.address}>
                      <Input
                        label={t('Block & Street', 'القطعة والشارع')}
                        value={formData.address}
                        onChange={e => updateField('address', e.target.value)}
                        className={
                          formErrors.address
                            ? 'border-red-500 focus:border-red-500 focus:ring-red-500'
                            : ''
                        }
                      />
                      {formErrors.address && (
                        <p className="mt-1 text-sm text-red-500">{formErrors.address}</p>
                      )}
                    </div>

                    <Input
                      label={t('Building / House / Apartment', 'المبنى / المنزل / الشقة')}
                      value={formData.apartment}
                      onChange={e => updateField('apartment', e.target.value)}
                    />

                    <div data-error={!!formErrors.city}>
                      <Input
                        label={t('City', 'المدينة')}
                        value={formData.city}
                        onChange={e => updateField('city', e.target.value)}
                        placeholder={t('e.g., Kuwait City', 'مثال: مدينة الكويت')}
                        className={
                          formErrors.city
                            ? 'border-red-500 focus:border-red-500 focus:ring-red-500'
                            : ''
                        }
                      />
                      {formErrors.city && (
                        <p className="mt-1 text-sm text-red-500">{formErrors.city}</p>
                      )}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-foreground mb-1">
                        {t('Order Notes (optional)', 'ملاحظات الطلب (اختياري)')}
                      </label>
                      <textarea
                        value={formData.notes}
                        onChange={e => updateField('notes', e.target.value)}
                        rows={3}
                        className="w-full rounded-lg border border-border px-4 py-2 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary"
                        placeholder={t(
                          'Any special delivery instructions...',
                          'أي تعليمات خاصة للتوصيل...'
                        )}
                      />
                    </div>
                  </div>

                  <div className="mt-6 flex justify-between">
                    <Link href={storeUrl('/cart')} className="text-sm text-primary hover:underline">
                      {language === 'ar' ? 'العودة إلى السلة →' : '← Return to cart'}
                    </Link>
                    <Button type="submit">{t('Continue to Payment', 'المتابعة للدفع')}</Button>
                  </div>
                </div>
              )}

              {step === 2 && (
                <div className="space-y-6">
                  {/* Checkout Error Display */}
                  {checkoutError && (
                    <div className="rounded-xl border border-red-200 bg-red-50 p-4">
                      <div className="flex items-start gap-3">
                        <svg
                          className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5"
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
                          <h3 className="text-sm font-medium text-red-800">
                            {t('Checkout Error', 'خطأ في الدفع')}
                          </h3>
                          <p className="mt-1 text-sm text-red-700">{checkoutError}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setCheckoutError(null)}
                          className="text-red-500 hover:text-red-700"
                        >
                          <svg
                            className="h-4 w-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
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
                      <h3 className="font-medium text-foreground">
                        {t('Shipping to', 'الشحن إلى')}
                      </h3>
                      <button
                        type="button"
                        onClick={() => setStep(1)}
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
                      {(paymentProviders.length > 0
                        ? paymentProviders
                        : DEFAULT_PAYMENT_PROVIDERS
                      ).map(provider => {
                        // Get display info - use API data or fallback to defaults
                        const defaultInfo = DEFAULT_PAYMENT_PROVIDERS.find(
                          p => p.id === provider.id
                        );
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
                                : 'border-border hover:border-border/80'
                            }`}
                          >
                            <input
                              type="radio"
                              name="paymentMethod"
                              value={provider.id}
                              checked={selectedProvider === provider.id}
                              onChange={e => setSelectedProvider(e.target.value)}
                              className="h-4 w-4 text-primary focus:ring-primary"
                            />
                            <div className="flex-1">
                              <span className="font-medium text-foreground">{displayName}</span>
                              {displayDescription && (
                                <p className="text-sm text-muted-foreground">
                                  {displayDescription}
                                </p>
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

                  <div className="flex justify-between">
                    <button
                      type="button"
                      onClick={() => setStep(1)}
                      className="text-sm text-primary hover:underline"
                    >
                      {language === 'ar' ? 'العودة إلى الشحن →' : '← Return to shipping'}
                    </button>
                    <Button
                      type="submit"
                      size="lg"
                      isLoading={isProcessing}
                      disabled={!selectedProvider}
                    >
                      {isProcessing
                        ? t('Processing...', 'جاري المعالجة...')
                        : selectedProvider === 'cod'
                          ? t('Place Order', translations['Place Order'])
                          : `${t('Pay', 'ادفع')} ${formatPrice(total)}`}
                    </Button>
                  </div>
                </div>
              )}
            </form>
          </div>

          {/* Order Summary */}
          <div className="mt-8 lg:col-span-5 lg:mt-0">
            <div className="sticky top-24 rounded-xl border bg-card p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-foreground">
                {t('Order Summary', translations['Order Summary'])}
              </h2>

              <div className="mt-6 divide-y">
                {cart.items.map(item => (
                  <div key={item.id} className="flex gap-4 py-4 first:pt-0">
                    <div className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg bg-muted">
                      {item.product.images?.[0] ? (
                        <Image
                          src={item.product.images[0].url}
                          alt={item.product.name}
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
                      <h3 className="text-sm font-medium text-foreground">{item.product.name}</h3>
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
                  <div className="flex items-center justify-between bg-green-50 p-3 rounded-lg">
                    <div>
                      <span className="text-sm font-medium text-green-700">
                        {appliedCoupon.code}
                      </span>
                      <span className="text-sm text-green-600 ml-2">
                        {appliedCoupon.type === 'percentage'
                          ? `${appliedCoupon.value}% ${t('off', 'خصم')}`
                          : appliedCoupon.type === 'free_shipping'
                            ? t('Free shipping', 'شحن مجاني')
                            : `${formatPrice(appliedCoupon.value)} ${t('off', 'خصم')}`}
                      </span>
                    </div>
                    <button onClick={removeCoupon} className="text-green-600 hover:text-green-800">
                      <svg
                        className="h-4 w-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
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
                      placeholder={t('Coupon code', 'كود الخصم')}
                      value={couponCode}
                      onChange={e => setCouponCode(e.target.value.toUpperCase())}
                      className="flex-1"
                    />
                    <Button type="button" variant="outline" onClick={handleApplyCoupon}>
                      {t('Apply', translations['Apply'])}
                    </Button>
                  </div>
                )}
                {couponError && <p className="mt-2 text-sm text-red-600">{couponError}</p>}
              </div>

              {/* Totals */}
              <div className="mt-6 space-y-3 border-t pt-6">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    {t('Subtotal', translations['Subtotal'])}
                  </span>
                  <span className="font-medium">{formatPrice(subtotal)}</span>
                </div>
                {discount > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-green-600">{t('Discount', 'الخصم')}</span>
                    <span className="font-medium text-green-600">-{formatPrice(discount)}</span>
                  </div>
                )}
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    {t('Shipping', translations['Shipping'])}
                  </span>
                  <span className={`font-medium ${freeShipping ? 'text-green-600' : ''}`}>
                    {freeShipping
                      ? t('Free', translations['Free'])
                      : shipping > 0
                        ? formatPrice(shipping)
                        : t('Select area', 'اختر المنطقة')}
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
        </div>
      </div>
    </main>
  );
}
